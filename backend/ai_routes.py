"""Read-only rollout status. No model calls, raw prompts, or learner data exposed."""
from fastapi import APIRouter

try:
    from backend.ai.contracts import SCHEMA_VERSION
    from backend.ai.prompts import PROMPT_VERSION
    from backend.ai.settings import load_settings
except ModuleNotFoundError:
    from ai.contracts import SCHEMA_VERSION
    from ai.prompts import PROMPT_VERSION
    from ai.settings import load_settings

router = APIRouter(prefix="/api/v1/ai")


@router.get("/status")
def ai_status():
    try:
        settings = load_settings()
        configured, ready, valid = bool(settings.api_key), settings.ready, True
        model, policy = settings.model, settings.data_policy
    except ValueError:
        configured, ready, valid = False, False, False
        model, policy = None, None
    # The operator CLI can perform a shadow call, but no paid student endpoint
    # or automatic dispatch is enabled merely because a key exists.
    return {"runtime_provider": "disabled", "external_calls_enabled": False,
            "semantic_feedback_available": False, "learning_updates_enabled": False,
            "offline_fake_available": True, "schema_version": SCHEMA_VERSION,
            "prompt_version": PROMPT_VERSION,
            "tasks": ["teacher", "evaluator", "diagnose"],
            "provider_selected": "deepseek", "model": model, "data_policy": policy,
            "configuration_valid": valid, "key_configured": configured,
            "shadow_feedback_available": ready, "student_feedback_enabled": False,
            "max_output_tokens_per_call": 768,
            "reason": "DeepSeek 适配器已接入独立影子联调；学生侧自动反馈未开放，不改变等级或积分。" if ready else
                      "AI 配置无效，请在本机后端修正。" if not valid else
                      "DeepSeek 影子联调等待后端密钥与启用开关；不伪装为已完成真实调用。"}
