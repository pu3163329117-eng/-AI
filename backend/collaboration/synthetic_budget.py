"""Frozen, synthetic-only four-attempt HTTP integration contract.

This is an intentionally narrow rollout permit, not general model access.
Only a human-authorized local launcher creates an execute policy.
"""
import hashlib
import json
from pathlib import Path
import re
import uuid

from .errors import RuntimeFailure


SOURCE_ID = "synthetic/harness-first-integration"
CONTENT = "纯合成规则：甲、乙、丙中，仅乙符合候选条件。任何结果只作候选，不代表人工审核。"
CANDIDATE = {"candidate": "乙", "source_id": SOURCE_ID, "review_status": "CANDIDATE"}
_ANSWER = json.dumps(CANDIDATE, ensure_ascii=False, separators=(",", ":"))
PROMPTS = {
    "first": f"合成后端联调/创建：仅依据合成规则返回 JSON {_ANSWER}。不调用工具。",
    "followup": f"合成后端联调/追问：核对本任务上一轮候选仍为乙且未审核，仅返回 JSON {_ANSWER}。不调用工具。",
    "cancel": f"合成后端联调/运行取消：仅依据合成规则返回 JSON {_ANSWER}。不调用工具。",
    "interrupted": f"合成后端联调/异常恢复：仅依据合成规则返回 JSON {_ANSWER}。不调用工具。",
}
QUEUED_CANCEL_PROMPT = "合成后端联调/排队取消：本请求必须在派发前取消，禁止调用模型。"
SHORT_PROMPT = "根据合成规则，只输出一个汉字：乙。不要解释、JSON、代码块或工具。"


def task_request():
    return {"project_id": "wenyan-synthetic-backend-closure", "title": "Harness 合成后端闭环",
            "objective": "仅用合成规则检验任务、追问、读取、取消和恢复，不访问真实资料。",
            "acceptance_criteria": ["候选为乙且来源正确", "保持 CANDIDATE", "回执与完成轮次关联", "取消和恢复不自动重试"],
            "forbidden_actions": ["访问文件", "执行工具", "发布或审核", "使用学习记录"],
            "context_items": [{"layer": "project_baseline", "source_id": SOURCE_ID,
                               "source_version": "sha256:" + hashlib.sha256(CONTENT.encode("utf-8")).hexdigest(),
                               "classification": "synthetic", "content": CONTENT}], "max_context_bytes": 8192}


def make_policy(mode="offline", *, continuation=None, remaining_two=None, last_one=None):
    if mode not in {"offline", "execute"}:
        raise ValueError("SYNTHETIC_POLICY_MODE_INVALID")
    policy = {"version": 1, "transport": mode,
            "authorization_status": "APPROVED_FOUR_CALLS" if mode == "execute" else "OFFLINE_ONLY",
            "provider": "deepseek-official", "model": "deepseek-flash", "max_calls": 4,
            "max_output_tokens": 128, "max_prompt_bytes": 8192, "timeout_seconds": 60,
            "automatic_retries": 0, "scenarios": list(PROMPTS), "task_request": task_request(), "prompts": PROMPTS}
    if continuation is not None:
        try:
            if (set(continuation) != {"plan", "first_attempt_sha256", "original_run_id"}
                    or continuation["plan"] != "timeout_recovery_remaining_three"
                    or not re.fullmatch(r"[0-9a-f]{64}", continuation["first_attempt_sha256"])):
                raise ValueError()
            uuid.UUID(continuation["original_run_id"])
        except (ValueError, TypeError, AttributeError, KeyError):
            raise ValueError("SYNTHETIC_CONTINUATION_INVALID") from None
        policy["continuation"] = dict(continuation)
    if remaining_two is not None:
        try:
            if continuation is not None or set(remaining_two) != {"plan", "locks"} or remaining_two["plan"] != "remaining_two_180s":
                raise ValueError()
            if set(remaining_two["locks"]) != {"first", "interrupted"}:
                raise ValueError()
            for entry in remaining_two["locks"].values():
                if set(entry) != {"sha256", "run_id"} or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
                    raise ValueError()
                uuid.UUID(entry["run_id"])
        except (ValueError, TypeError, AttributeError, KeyError):
            raise ValueError("SYNTHETIC_REMAINING_TWO_INVALID") from None
        policy["remaining_two"] = remaining_two
        policy["timeout_seconds"] = 180
    if last_one is not None:
        try:
            if (continuation is not None or remaining_two is not None or set(last_one) != {"plan", "locks"}
                    or last_one["plan"] != "last_one_short_output_180s"
                    or set(last_one["locks"]) != {"first", "interrupted", "followup"}):
                raise ValueError()
            for entry in last_one["locks"].values():
                if set(entry) != {"sha256", "run_id"} or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
                    raise ValueError()
                uuid.UUID(entry["run_id"])
        except (ValueError, TypeError, AttributeError, KeyError):
            raise ValueError("SYNTHETIC_LAST_ONE_INVALID") from None
        policy.update(last_one=last_one, timeout_seconds=180, short_prompt=SHORT_PROMPT, expected_output="乙")
    return policy


def load_policy(path: Path):
    try:
        raw = path.read_bytes()
        policy = json.loads(raw)
        if policy != make_policy(policy["transport"], continuation=policy.get("continuation"),
                                 remaining_two=policy.get("remaining_two"), last_one=policy.get("last_one")):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise RuntimeFailure("DSH_SYNTHETIC_POLICY_INVALID") from None
    return policy, hashlib.sha256(raw).hexdigest()


def validate_envelope(envelope, *, continuation=False, remaining_two=False, last_one=False):
    expected = task_request()
    task = dict(envelope.task_spec)
    if task.pop("task_id", None) != envelope.task_id or task != {key: expected[key] for key in (
            "project_id", "title", "objective", "acceptance_criteria", "forbidden_actions")}:
        raise RuntimeFailure("DSH_SYNTHETIC_TASK_DENIED")
    manifest = envelope.manifest
    scope = {"classifications": ["synthetic"], "read_only": True, "learner_records": False,
             "shell": False, "publish": False, "approval": False}
    if (manifest.get("items") != expected["context_items"] or manifest.get("task_id") != envelope.task_id
            or manifest.get("version") != 1 or manifest.get("truncated") is not False
            or manifest.get("authorization_scope") != scope):
        raise RuntimeFailure("DSH_SYNTHETIC_MANIFEST_DENIED")
    scenario = ("cancel" if envelope.prompt == SHORT_PROMPT else None) if last_one else next((key for key, prompt in PROMPTS.items() if prompt == envelope.prompt), None)
    if scenario is None:
        raise RuntimeFailure("DSH_SYNTHETIC_REQUEST_DENIED")
    if not (1 <= envelope.max_output_tokens <= 128 and 1 <= envelope.timeout_seconds <= (180 if remaining_two or last_one else 60)):
        raise RuntimeFailure("DSH_SYNTHETIC_BUDGET_EXCEEDED")
    if len(envelope.history) != (2 if scenario == "followup" else 0):
        raise RuntimeFailure("DSH_SYNTHETIC_HISTORY_DENIED")
    if envelope.history:
        user, assistant = envelope.history
        try:
            prior_prompt = PROMPTS["interrupted"] if continuation else PROMPTS["first"]
            valid = (user["role"] == "user" and user["content"] == prior_prompt
                     and assistant["role"] == "assistant" and json.loads(assistant["content"]) == CANDIDATE
                     and assistant["interpretation"] == "unverified_model_candidate"
                     and all(item["input_manifest_id"] == manifest["id"] for item in envelope.history)
                     and all(item["content_sha256"] == hashlib.sha256(item["content"].encode("utf-8")).hexdigest()
                             for item in envelope.history))
        except (ValueError, KeyError, TypeError):
            valid = False
        if not valid:
            raise RuntimeFailure("DSH_SYNTHETIC_HISTORY_DENIED")
    if remaining_two:
        if scenario not in {"first", "followup"}:
            raise RuntimeFailure("DSH_SYNTHETIC_REQUEST_DENIED")
        return {"first": "followup", "followup": "cancel"}[scenario]
    return scenario
