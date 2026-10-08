"""Vendor-neutral boundary and offline fake; the real adapter lives in deepseek.py."""
from collections import deque
from dataclasses import dataclass
import json
from typing import Protocol

from .contracts import SCHEMA_VERSION, Task
from .prompts import PROMPT_VERSION

ERROR_CODES = frozenset({"PROVIDER_TIMEOUT", "RATE_LIMITED", "INVALID_OUTPUT", "SAFETY_BLOCKED", "PROVIDER_UNAVAILABLE"})


class ProviderError(Exception):
    def __init__(self, code):
        if code not in ERROR_CODES:
            raise ValueError("Unknown provider error")
        self.code = code
        # Do not retain vendor responses, secrets, input data, or nested error messages.
        super().__init__(code)


@dataclass(frozen=True)
class StructuredRequest:
    task: Task
    system: str
    data_json: str
    output_schema: dict
    repair: bool = False
    schema_version: str = SCHEMA_VERSION
    prompt_version: str = PROMPT_VERSION


class ModelProvider(Protocol):
    name: str
    external: bool

    async def generate_structured(self, request: StructuredRequest) -> str: ...


class FakeProvider:
    """Fixed transport fixtures, NOT semantic AI. Evaluator never awards a score.

    Scripted outputs are only for isolated contract/security tests. Calls remain
    in memory; nothing is logged or sent over a network.
    """
    name = "offline-fake"
    external = False

    def __init__(self, outputs=()):
        self.outputs = deque(outputs)
        self.calls = []

    async def generate_structured(self, request):
        self.calls.append(request)
        if self.outputs:
            result = self.outputs.popleft()
            if isinstance(result, Exception):
                raise result
            return result
        data = {
            "teacher": {"utterance": "请回到已显示的原文，核对证据与判断的关系。", "ui_action": "NONE",
                        "focus_span_ids": [], "prohibited_answer_leak": False},
            "evaluator": {"label": "UNSCORABLE", "score": None, "matched_rubric_items": [],
                          "misconception_codes": [], "evidence_ids": [], "evidence_quality": None,
                          "next_action_recommendation": "HUMAN_REVIEW", "confidence": None},
            "diagnose": {"diagnosis_code": "INSUFFICIENT_DATA", "confidence": None,
                         "supporting_observation_ids": [], "recommended_hint_skill": "HUMAN_REVIEW"},
        }[request.task]
        return json.dumps(data, ensure_ascii=False)
