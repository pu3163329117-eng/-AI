from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.config import API_PREFIX
from backend.db.init import init_db
from backend.db.models import CommandReceipt, LearnerProfile, TrainingEvent, TrainingSession
from backend.db.session import get_db
from backend.domain.training import apply_command, initial_snapshot
from backend.schemas import CommandRequest, CreateProfileRequest, CreateSessionRequest

DbSession = Annotated[Session, Depends(get_db)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="文言·推理 API", version="0.1.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def api_error(_: Request, exc: HTTPException) -> JSONResponse:
    """Keep API errors stable for web and mobile clients rather than exposing FastAPI's `detail` envelope."""
    error = exc.detail if isinstance(exc.detail, dict) else {"code": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": error})


def _session_payload(record: TrainingSession) -> dict:
    return {"session_id": record.id, "session": record.snapshot}


def _hash_request(command: CommandRequest) -> str:
    return hashlib.sha256(command.model_dump_json().encode("utf-8")).hexdigest()


def _profile_payload(profile: LearnerProfile) -> dict:
    return {
        "id": profile.id,
        "display_name": profile.display_name,
        "school_stage": profile.school_stage,
        "total_points": profile.total_points,
        "completed_levels": profile.completed_levels,
    }


def _review_session_payload(record: TrainingSession) -> dict:
    snapshot = record.snapshot
    return {
        "session_id": record.id,
        "source": snapshot["source"],
        "stage": snapshot["stage"],
        "completed": snapshot["completed"],
        "feedback": snapshot["feedback"],
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "wenyan-api", "database": "sqlite"}


@app.post(f"{API_PREFIX}/profiles", status_code=status.HTTP_201_CREATED)
def create_profile(request: CreateProfileRequest, db: DbSession) -> dict:
    profile = LearnerProfile(display_name=request.display_name.strip(), school_stage=request.school_stage)
    if not profile.display_name:
        raise HTTPException(status_code=422, detail={"code": "DISPLAY_NAME_REQUIRED"})
    db.add(profile)
    db.commit()
    return {"profile": _profile_payload(profile)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}")
def get_profile(profile_id: str, db: DbSession) -> dict:
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    return {"profile": _profile_payload(profile)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/sessions")
def list_profile_sessions(profile_id: str, db: DbSession) -> dict:
    if not db.get(LearnerProfile, profile_id):
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(
        select(TrainingSession)
        .where(TrainingSession.profile_id == profile_id)
        .order_by(TrainingSession.updated_at.desc())
        .limit(20)
    ).all()
    return {"sessions": [_review_session_payload(record) for record in records]}


@app.post(f"{API_PREFIX}/training/sessions", status_code=status.HTTP_201_CREATED)
def create_session(request: CreateSessionRequest, db: DbSession) -> dict:
    profile = db.get(LearnerProfile, request.profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    snapshot = initial_snapshot()
    snapshot["profile_id"] = profile.id
    record = TrainingSession(profile_id=profile.id, state_version=snapshot["state_version"], snapshot=snapshot)
    db.add(record)
    db.commit()
    return _session_payload(record)


@app.get(f"{API_PREFIX}/training/sessions/{{session_id}}")
def get_session(session_id: str, db: DbSession) -> dict:
    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    return {"session": record.snapshot}


@app.post(f"{API_PREFIX}/training/sessions/{{session_id}}/commands")
def command(
    session_id: str,
    request: CommandRequest,
    db: DbSession,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict:
    if not idempotency_key:
        raise HTTPException(status_code=400, detail={"code": "IDEMPOTENCY_KEY_REQUIRED"})

    request_hash = _hash_request(request)
    receipt = db.scalar(select(CommandReceipt).where(CommandReceipt.session_id == session_id, CommandReceipt.idempotency_key == idempotency_key))
    if receipt:
        if receipt.request_hash != request_hash:
            raise HTTPException(status_code=409, detail={"code": "IDEMPOTENCY_KEY_REUSED"})
        return receipt.response

    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    if request.expected_state_version != record.state_version:
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT", "current_state_version": record.state_version})

    try:
        result = apply_command(record.snapshot, request.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": str(exc)}) from exc

    # Optimistic update is the concurrency boundary; no process-global lock is needed.
    updated = db.execute(
        update(TrainingSession)
        .where(TrainingSession.id == session_id, TrainingSession.state_version == request.expected_state_version)
        .values(state_version=result.snapshot["state_version"], snapshot=result.snapshot)
    )
    if updated.rowcount != 1:
        db.rollback()
        current = db.get(TrainingSession, session_id)
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT", "current_state_version": current.state_version if current else None})

    for offset, event in enumerate(result.events, start=1):
        db.add(TrainingEvent(session_id=session_id, sequence_no=request.expected_state_version + offset, type=event["type"], payload=event["payload"]))
    response = {"session_id": session_id, "state": result.state, "state_version": result.snapshot["state_version"], "session": result.snapshot}
    if request.type == "COMPLETE_SESSION":
        profile_id = result.snapshot.get("profile_id")
        profile = db.get(LearnerProfile, profile_id) if profile_id else None
        if profile:
            profile.total_points += result.snapshot["summary"]["earned_points"]
            profile.completed_levels += 1
            response["profile"] = _profile_payload(profile)
    db.add(CommandReceipt(session_id=session_id, idempotency_key=idempotency_key, request_hash=request_hash, response=response))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raced_receipt = db.scalar(select(CommandReceipt).where(CommandReceipt.session_id == session_id, CommandReceipt.idempotency_key == idempotency_key))
        if raced_receipt and raced_receipt.request_hash == request_hash:
            return raced_receipt.response
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT"})
    return response
