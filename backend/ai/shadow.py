"""Operator-only shadow evaluation; independent of learner APIs and database writes."""
from .contracts import INPUTS
from .deepseek import DeepSeekProvider
from .service import FeedbackService


async def shadow_review(settings, case, *, live=False, transport=None):
    if not isinstance(case, dict) or set(case) != {"task", "data_kind", "payload", "answer_aliases"}:
        raise ValueError("AI_CASE_INVALID")
    task, kind = case["task"], case["data_kind"]
    if task not in INPUTS or kind not in {"synthetic", "minimal_learning"}:
        raise ValueError("AI_CASE_INVALID")
    if kind == "minimal_learning" and settings.data_policy != "minimal_learning":
        raise ValueError("AI_DATA_POLICY_REQUIRED")
    # Validate input before instantiating any paid adapter; extras cannot ride along.
    try:
        payload = INPUTS[task].model_validate(case["payload"]).model_dump()
    except (ValueError, TypeError):
        raise ValueError("AI_CASE_INVALID") from None
    provider = DeepSeekProvider(settings, transport=transport) if live and settings.ready else None
    service = FeedbackService(provider, approved_external=("deepseek",) if provider else ())
    result = await service.run(task, payload, answer_aliases=case["answer_aliases"])
    # Feedback is a read-only candidate, never a teacher review or capability level.
    return {"mode": "SHADOW", "data_kind": kind, "status": result.status,
            "output": result.output, "error_code": result.error_code,
            "simulated": result.simulated, "may_update_learning": False, "trace": result.trace,
            "rubric_review_status": "NOT_VERIFIED", "live_requested": live,
            "external_call_attempted": bool(provider and result.trace["attempts"])}
