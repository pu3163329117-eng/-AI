"""Fail-closed feedback orchestration. No database or training-engine dependency."""
import asyncio
from dataclasses import dataclass
import json
import re
from time import monotonic
import unicodedata
from uuid import uuid4

from pydantic import ValidationError

from .contracts import INPUTS, OUTPUTS, SCHEMA_VERSION, Task
from .prompts import PROMPTS, PROMPT_VERSION
from .providers import FakeProvider, ModelProvider, ProviderError, StructuredRequest

ATTACK = re.compile(
    r"ignore\s+(?:all\s+)?(?:previous|system)\s+instructions|"
    r"忽略.{0,20}(?:指令|规则)|(?:输出|显示|泄露).{0,15}(?:系统提示|密钥)|"
    r"reveal.{0,20}(?:system\s+prompt|api\s+key)", re.IGNORECASE,
)


def normalized(text):
    return "".join(c.casefold() for c in unicodedata.normalize("NFKC", text)
                   if unicodedata.category(c)[0] in {"L", "N"})


def unique_ids(items):
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("AI_INPUT_INVALID")
    return set(ids)


def parse_json(raw):
    if not isinstance(raw, str):
        raise ProviderError("INVALID_OUTPUT")
    try:
        if len(raw.encode("utf-8")) > 32_000:
            raise ProviderError("INVALID_OUTPUT")
    except UnicodeError:
        raise ProviderError("INVALID_OUTPUT") from None

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("nonfinite number")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError):
        raise ProviderError("INVALID_OUTPUT") from None


def validate_output(task, raw, data, answer_aliases):
    try:
        output = OUTPUTS[task].model_validate(parse_json(raw))
        # Validate the original candidate before confidence/abstention
        # normalization can remove malformed duplicate references.
        for key in ("focus_span_ids", "evidence_ids", "matched_rubric_items", "supporting_observation_ids", "misconception_codes"):
            values = getattr(output, key, [])
            if len(values) != len(set(values)):
                raise ValueError("duplicate references")
        if task == "teacher":
            if not set(output.focus_span_ids) <= unique_ids(data.visible_evidence):
                raise ValueError("unknown evidence")
            if output.ui_action == "FOCUS_EVIDENCE" and not output.focus_span_ids:
                raise ValueError("missing focus")
            if output.ui_action == "NONE" and output.focus_span_ids:
                raise ValueError("inconsistent focus")
            utterance = normalized(output.utterance or "")
            if any(normalized(alias) and normalized(alias) in utterance for alias in answer_aliases):
                raise ProviderError("SAFETY_BLOCKED")
        elif task == "evaluator":
            if not set(output.evidence_ids) <= unique_ids(data.visible_evidence):
                raise ValueError("unknown evidence")
            if not set(output.matched_rubric_items) <= unique_ids(data.rubric):
                raise ValueError("unknown rubric")
            if output.label != "UNSCORABLE" and output.confidence < .65:
                output = OUTPUTS[task].model_validate({
                    "label": "UNSCORABLE", "score": None, "matched_rubric_items": [],
                    "misconception_codes": [], "evidence_ids": output.evidence_ids,
                    "evidence_quality": None, "next_action_recommendation": "HUMAN_REVIEW", "confidence": None,
                })
        else:
            if not set(output.supporting_observation_ids) <= unique_ids(data.observations):
                raise ValueError("unknown observation")
            if output.confidence is None or output.confidence < .65 or output.diagnosis_code == "INSUFFICIENT_DATA":
                output = OUTPUTS[task].model_validate({
                    "diagnosis_code": "INSUFFICIENT_DATA", "confidence": None,
                    "supporting_observation_ids": [], "recommended_hint_skill": "HUMAN_REVIEW",
                })
        return output.model_dump()
    except (ValidationError, ValueError, TypeError, RecursionError):
        raise ProviderError("INVALID_OUTPUT") from None


@dataclass(frozen=True)
class Feedback:
    status: str
    output: dict
    error_code: str | None
    simulated: bool
    may_update_learning: bool
    trace: dict


class FeedbackService:
    """One provider per instance, at most one repair, four-second total deadline.

    External providers require explicit approval when constructing the service;
    no automatic vendor routing/fallback exists. The breaker is process-local.
    The integration gate ALWAYS forbids writing scores, points, or mastery.
    """
    def __init__(self, provider: ModelProvider | None = None, *, approved_external=(),
                 timeout_seconds=4.0, failure_threshold=2, cooldown_seconds=30.0, clock=monotonic):
        if not 0 < timeout_seconds <= 4 or failure_threshold < 1 or cooldown_seconds < 0:
            raise ValueError("AI_POLICY_INVALID")
        self.provider = provider
        self.approved_external = frozenset(approved_external)
        self.timeout_seconds = timeout_seconds
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self.clock = clock
        self.failures = 0
        self.opened_at = None
        self.lock = asyncio.Lock()

    async def run(self, task: Task, input_data: dict, *, answer_aliases=()):
        started = monotonic()
        if task not in INPUTS:
            raise ValueError("AI_TASK_INVALID")
        try:
            data = INPUTS[task].model_validate(input_data)
            for collection in ("visible_evidence", "rubric", "observations"):
                if hasattr(data, collection):
                    unique_ids(getattr(data, collection))
            if (not isinstance(answer_aliases, (tuple, list)) or len(answer_aliases) > 12
                or any(not isinstance(a, str) or len(a) > 200 or not normalized(a) for a in answer_aliases)):
                raise ValueError("invalid aliases")
            # A teacher adapter cannot be enabled without a server-held answer guard.
            if task == "teacher" and not answer_aliases:
                raise ValueError("missing answer guard")
        except (ValidationError, ValueError, TypeError):
            raise ValueError("AI_INPUT_INVALID") from None
        request_data = json.dumps(data.model_dump(), ensure_ascii=False)
        trace = {"trace_id": str(uuid4()), "task": task, "schema_version": SCHEMA_VERSION,
                 "prompt_version": PROMPT_VERSION, "attempts": 0,
                 "provider": self.provider.name if self.provider else "disabled"}
        simulated = isinstance(self.provider, FakeProvider)

        async def finish(output, code=None):
            trace["status"] = "FALLBACK" if code else "OK"
            trace["error_code"] = code
            trace["elapsed_ms"] = round((monotonic() - started) * 1000)
            return Feedback(trace["status"], output, code, simulated, False, dict(trace))

        async def fallback(code):
            # Safe, explicitly unscorable templates; no vendor output is reflected.
            raw = await FakeProvider().generate_structured(StructuredRequest(
                task=task, system="", data_json="{}", output_schema={}))
            safe = OUTPUTS[task].model_validate_json(raw).model_dump()
            if task == "teacher" and any(normalized(a) in normalized(safe["utterance"]) for a in answer_aliases):
                safe["utterance"] = "请自行核对所选材料。"
                # Any guard collision falls back to no utterance, not an unguarded alternate.
                if any(normalized(a) in normalized(safe["utterance"]) for a in answer_aliases):
                    safe = {"ui_action": "NONE", "focus_span_ids": [], "prohibited_answer_leak": False, "utterance": None}
            safe = OUTPUTS[task].model_validate(safe).model_dump()
            return await finish(safe, code)

        if ATTACK.search(request_data):
            return await fallback("SAFETY_BLOCKED")
        if self.provider is None or (self.provider.external and self.provider.name not in self.approved_external):
            return await fallback("PROVIDER_UNAVAILABLE")
        try:
            # Waiting for the per-provider lock is included in the total budget.
            async with asyncio.timeout(self.timeout_seconds):
                async with self.lock:
                    if self.opened_at is not None and self.clock() - self.opened_at < self.cooldown_seconds:
                        return await fallback("PROVIDER_UNAVAILABLE")
                    try:
                        for attempt in range(2):
                            trace["attempts"] += 1
                            system = PROMPTS[task] + (" Previous output failed validation. Regenerate fresh schema-valid JSON using only the original data." if attempt else "")
                            request = StructuredRequest(task=task, system=system, data_json=request_data,
                                output_schema=OUTPUTS[task].model_json_schema(), repair=bool(attempt))
                            try:
                                output = validate_output(task, await self.provider.generate_structured(request), data, answer_aliases)
                                self.failures = 0
                                self.opened_at = None
                                return await finish(output)
                            except ProviderError as error:
                                if error.code != "INVALID_OUTPUT" or attempt:
                                    raise
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        self.failures += 1
                        if self.failures >= self.failure_threshold:
                            self.opened_at = self.clock()
                        code = error.code if isinstance(error, ProviderError) else "PROVIDER_UNAVAILABLE"
                        return await fallback(code)
        except TimeoutError:
            # Timeouts while waiting are not proof that a new vendor call failed.
            if trace["attempts"]:
                self.failures += 1
                if self.failures >= self.failure_threshold:
                    self.opened_at = self.clock()
            return await fallback("PROVIDER_TIMEOUT")
