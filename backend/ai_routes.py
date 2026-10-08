"""Rollout status and voluntary local shadow preview, never learning writes."""
from copy import deepcopy
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from sqlalchemy.orm import Session

try:
    from backend.ai.contracts import SCHEMA_VERSION
    from backend.ai.prompts import PROMPT_VERSION
    from backend.ai.settings import load_settings
    from backend.ai.preview import preview_input, runtime
    from backend.db.models import TrainingSession
    from backend.db.session import get_db
except ModuleNotFoundError:
    from ai.contracts import SCHEMA_VERSION
    from ai.prompts import PROMPT_VERSION
    from ai.settings import load_settings
    from ai.preview import preview_input, runtime
    from db.models import TrainingSession
    from db.session import get_db

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
    # No automatic dispatch or formal student release. A separately guarded,
    # voluntary loopback-only shadow preview is available with data permission.
    return {"runtime_provider": "disabled", "external_calls_enabled": False,
            "semantic_feedback_available": False, "learning_updates_enabled": False,
            "offline_fake_available": True, "schema_version": SCHEMA_VERSION,
            "prompt_version": PROMPT_VERSION,
            "tasks": ["teacher", "evaluator", "diagnose"],
            "provider_selected": "deepseek", "model": model, "data_policy": policy,
            "configuration_valid": valid, "key_configured": configured,
            "shadow_feedback_available": ready, "student_feedback_enabled": False,
            "local_preview_available": ready and policy == "minimal_learning",
            "local_preview_external_calls_enabled": ready and policy == "minimal_learning",
            "max_output_tokens_per_call": 768,
            "reason": "DeepSeek 支持独立影子联调与本机手动理由试用；学生侧正式反馈未开放，不改变等级或积分。" if ready else
                      "AI 配置无效，请在本机后端修正。" if not valid else
                      "DeepSeek 影子联调等待后端密钥与启用开关；不伪装为已完成真实调用。"}


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_state_version: Annotated[int, Field(strict=True, ge=1)]
    send_minimal_data: StrictBool

    @field_validator("send_minimal_data")
    @classmethod
    def explicit_consent(cls, value):
        if value is not True:
            raise ValueError("Explicit consent required")
        return value


def local_preview_only(request: Request):
    # This isn't authentication. Keep the paid preview away from LAN/public
    # clients until authentication and teacher-quality release gates exist.
    local = {"127.0.0.1", "localhost", "::1"}
    if not request.client or request.client.host not in local or request.url.hostname not in local:
        raise HTTPException(403, {"code": "AI_LOCAL_PREVIEW_ONLY"})
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            allowed = parsed.scheme in {"http", "https"} and parsed.hostname in local and parsed.port in {5173, 8000} and not parsed.username and not parsed.password
        except ValueError:
            allowed = False
        if not allowed:
            raise HTTPException(403, {"code": "AI_LOCAL_PREVIEW_ONLY"})


@router.post("/sessions/{session_id}/reason-feedback", dependencies=[Depends(local_preview_only)])
async def reason_feedback(session_id: str, body: PreviewRequest, db: Session = Depends(get_db)):
    try:
        settings = load_settings()
    except ValueError:
        raise HTTPException(503, {"code": "AI_CONFIGURATION_INVALID"}) from None
    if not settings.ready or settings.data_policy != "minimal_learning":
        raise HTTPException(503, {"code": "AI_PREVIEW_DISABLED"})
    record = db.get(TrainingSession, session_id)
    if record is None:
        raise HTTPException(404, {"code": "SESSION_NOT_FOUND"})
    if record.state_version != body.expected_state_version:
        raise HTTPException(409, {"code": "AI_FEEDBACK_STALE"})
    snapshot = deepcopy(record.snapshot)
    try:
        payload = preview_input(snapshot)
    except ValueError as error:
        code = "AI_FIRST_ATTEMPT_REQUIRED" if str(error) == "AI_FIRST_ATTEMPT_REQUIRED" else "AI_REASONING_REQUIRED"
        raise HTTPException(422, {"code": code}) from None
    # Release the read transaction while waiting on the vendor. No writes.
    db.rollback()
    try:
        value = await runtime.run(settings, session_id, body.expected_state_version, payload)
    except ValueError:
        raise HTTPException(409, {"code": "AI_FEEDBACK_BUSY"}) from None
    fresh = db.get(TrainingSession, session_id, populate_existing=True)
    if fresh is None or fresh.state_version != body.expected_state_version:
        raise HTTPException(409, {"code": "AI_FEEDBACK_STALE"})
    return {"feedback": value}
