"""Invitation-account tour and deliberately minimal support submission API."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

try:
    from backend.db.experience_models import AccountTourProgress, SupportFeedback, SupportReply
    from backend.db.session import get_db
except ModuleNotFoundError:
    from db.experience_models import AccountTourProgress, SupportFeedback, SupportReply
    from db.session import get_db

router = APIRouter(prefix="/api/v1", tags=["experience-support"])
Db = Annotated[Session, Depends(get_db)]
TOUR_VERSION = "2026-10-v1"
Page = Literal["#/home", "#/onboarding", "#/tour", "#/training", "#/assessment", "#/practice", "#/review", "#/profile", "#/report", "#/ability", "#/skills", "#/admin", "#/login", "#/other", "#/about"]
SENSITIVE = re.compile(
    r"(?:\b(?:sk|re)_[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|"
    r"\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:cookie|authorization|api[_ -]?key)\s*[:=]\s*\S+|"
    r"(?:验证码|OTP|verification\s*code)\s*(?:是|为|[:：=])?\s*[0-9]{6}\b|"
    r"(?:邀请码|invite[_ -]?code)\s*(?:是|为|[:：=])?\s*[A-Za-z0-9_-]{16,}|"
    r"\bwenyan_beta_session\s*=\s*\S+|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,128}(?![A-Za-z0-9_-])|"
    r"(?<![0-9])[0-9]{6}(?![0-9]))", re.IGNORECASE,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def fail(code: str, status: int = 409, headers: dict | None = None):
    raise HTTPException(status, {"code": code}, headers=headers)


def account(request: Request) -> str:
    # Global access guard supplies this only after real invitation authentication.
    # Local preview never writes a fake account or accepts real support content.
    user_id = getattr(request.state, "auth_user_id", None)
    if not user_id:
        fail("EXPERIENCE_ACCOUNT_REQUIRED")
    return user_id


def writer(db: Session) -> None:
    # Supported deployment is SQLite. A reserved write lock serializes quota,
    # idempotency and tour updates across processes, not merely Python threads.
    if db.get_bind().dialect.name != "sqlite":
        fail("EXPERIENCE_STORAGE_UNSUPPORTED", 503)
    try:
        db.execute(text("BEGIN IMMEDIATE"))
    except OperationalError:
        db.rollback()
        fail("BETA_BUSY", 503, {"Retry-After": "2"})


class TourInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(max_length=40)
    step: int = Field(ge=0, le=3, strict=True)
    complete: bool = Field(strict=True)


def tour_result(record: AccountTourProgress | None) -> dict:
    return {"version": TOUR_VERSION, "step": record.step if record else 0,
            "completed": bool(record and record.completed_at),
            "completed_at": iso(record.completed_at) if record else None}


@router.get("/experience/tour")
def get_tour(request: Request, db: Db):
    return tour_result(db.get(AccountTourProgress, (account(request), TOUR_VERSION)))


@router.post("/experience/tour")
def update_tour(body: TourInput, request: Request, db: Db):
    user_id = account(request)
    if body.version != TOUR_VERSION:
        fail("TOUR_VERSION_CONFLICT")
    writer(db)
    try:
        record = db.get(AccountTourProgress, (user_id, TOUR_VERSION))
        current = record.step if record else 0
        if body.step > current + 1:
            fail("TOUR_STEP_CONFLICT")
        if body.complete and (current != 3 or body.step != 3):
            fail("TOUR_NOT_READY")
        if record is None:
            record = AccountTourProgress(user_id=user_id, version=TOUR_VERSION, step=0)
            db.add(record)
        record.step = max(current, body.step)
        if body.complete and record.completed_at is None:
            record.completed_at = utcnow()
        db.commit()
        return tour_result(record)
    except Exception:
        db.rollback()
        raise


class FeedbackInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    kind: Literal["feedback", "privacy", "deletion"]
    category: Literal["bug", "suggestion", "other"]
    message: str = Field(min_length=10, max_length=3000)
    device: str = Field(default="", max_length=120)
    page: Page
    build_version: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")

    @field_validator("message", "device", "build_version")
    @classmethod
    def reject_sensitive(cls, value: str) -> str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("SUPPORT_INVALID_TEXT") from None
        if SENSITIVE.search(value):
            raise ValueError("SUPPORT_SENSITIVE_CONTENT")
        if any(ord(char) < 32 and char not in "\n\t" for char in value):
            raise ValueError("SUPPORT_INVALID_TEXT")
        return value


def receipt(record: SupportFeedback) -> dict:
    return {"id": record.id, "reference": record.reference, "kind": record.kind,
            "status": record.status, "created_at": iso(record.created_at)}


@router.post("/support/feedback", status_code=201)
def submit_feedback(body: FeedbackInput, request: Request, db: Db):
    user_id = account(request)
    canonical = body.model_dump(mode="json", exclude={"request_id"})
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    writer(db)
    try:
        existing = db.scalar(select(SupportFeedback).where(SupportFeedback.user_id == user_id, SupportFeedback.request_id == str(body.request_id)))
        if existing:
            if not secrets.compare_digest(existing.content_digest, digest):
                fail("SUPPORT_IDEMPOTENCY_CONFLICT")
            # The original receipt is stable even after an operator resolves it.
            result = receipt(existing)
            result["status"] = "received"
            db.rollback()
            return result
        # Lock contention can cross the UTC day/rate window. Measure admission
        # after the write lock, not arrival, so quota and stored time agree.
        now = utcnow()
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        daily = db.scalar(select(func.count()).select_from(SupportFeedback).where(SupportFeedback.user_id == user_id, SupportFeedback.created_at >= day_start))
        recent = db.scalar(select(func.count()).select_from(SupportFeedback).where(SupportFeedback.user_id == user_id, SupportFeedback.created_at > now - timedelta(minutes=1)))
        if daily >= 5:
            fail("SUPPORT_DAILY_LIMIT", 429, {"Retry-After": str(max(1, int((day_start + timedelta(days=1) - now).total_seconds())))})
        if recent:
            fail("SUPPORT_RATE_LIMIT", 429, {"Retry-After": "60"})
        record = SupportFeedback(id=str(uuid4()), user_id=user_id, request_id=str(body.request_id),
            content_digest=digest, reference="WY-" + secrets.token_hex(8).upper(),
            **canonical, status="received", created_at=now, updated_at=now)
        db.add(record)
        db.commit()
        return receipt(record)
    except Exception:
        db.rollback()
        raise


@router.get("/support/feedback")
def list_receipts(request: Request, db: Db, limit: Annotated[int, Query(ge=1, le=20)] = 10):
    rows = db.scalars(select(SupportFeedback).where(SupportFeedback.user_id == account(request)).order_by(SupportFeedback.created_at.desc()).limit(limit))
    return {"items": [receipt(row) for row in rows]}


@router.get("/support/feedback/{feedback_id}")
def feedback_detail(feedback_id: str, request: Request, db: Db):
    user_id = account(request)
    try:
        record_id = str(UUID(feedback_id))
    except ValueError:
        fail("RESOURCE_NOT_FOUND", 404)
    record = db.scalar(select(SupportFeedback).where(SupportFeedback.id == record_id, SupportFeedback.user_id == user_id))
    if record is None:
        fail("RESOURCE_NOT_FOUND", 404)
    replies = db.scalars(select(SupportReply).where(SupportReply.feedback_id == record.id).order_by(SupportReply.created_at, SupportReply.id))
    # A resolved deletion *request* is workflow state, not a claim that account
    # data has been erased. No endpoint here deletes any account or learning data.
    return {"receipt": receipt(record), "category": record.category, "message": record.message,
        "page": record.page, "build_version": record.build_version, "updated_at": iso(record.updated_at),
        "replies": [{"id": reply.id, "message": reply.message, "created_at": iso(reply.created_at)} for reply in replies]}
