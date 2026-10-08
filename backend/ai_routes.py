"""Read-only rollout status. No model calls, raw prompts, or learner data exposed."""
from fastapi import APIRouter

try:
    from backend.ai.contracts import SCHEMA_VERSION
    from backend.ai.prompts import PROMPT_VERSION
except ModuleNotFoundError:
    from ai.contracts import SCHEMA_VERSION
    from ai.prompts import PROMPT_VERSION

router = APIRouter(prefix="/api/v1/ai")


@router.get("/status")
def ai_status():
    # No runtime feedback dispatcher/real adapter is installed in this rollout.
    # Do not manufacture a configured status from the mere presence of a key.
    return {"runtime_provider": "disabled", "external_calls_enabled": False,
            "semantic_feedback_available": False, "learning_updates_enabled": False,
            "offline_fake_available": True, "schema_version": SCHEMA_VERSION,
            "prompt_version": PROMPT_VERSION,
            "tasks": ["teacher", "evaluator", "diagnose"],
            "reason": "已实现离线反馈契约与安全边界；尚未接入真实模型，不提供语义评分，也不改变等级或积分。"}
