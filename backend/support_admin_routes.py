"""Protected support inbox; no account/learning joins, mail, or deletion actions.

The reply digest deliberately matches scripts/beta_support.py (including JSON
separator spaces). The HTTP layer does not import or invoke that operator CLI.
All mutations share its SQLite writer/CAS/idempotency protocol.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

try:
    from backend.auth.settings import load_access_settings
    from backend.support_admin_access import authorize_support
    from backend.db.session import get_db
except ModuleNotFoundError:
    from auth.settings import load_access_settings
    from support_admin_access import authorize_support
    from db.session import get_db


PREFIX = "/api/v1/admin/support/feedback"
Status = Literal["received", "in_progress", "resolved", "withdrawn"]
Kind = Literal["feedback", "privacy", "deletion"]
STATES = ("received", "in_progress", "resolved", "withdrawn")
KINDS = ("feedback", "privacy", "deletion")
META = "id, reference, kind, category, page, build_version, status, created_at, updated_at"
META_KEYS = tuple(META.split(", "))
STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])?\Z")
REFERENCE = re.compile(r"WY-[0-9A-F]{16}\Z")
# Same conservative credential rejection as the existing operator reply CLI.
# This is not a claim of comprehensive PII detection.
SENSITIVE = re.compile(
    r"(?:\b(?:sk|re)_[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|"
    r"\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:cookie|authorization|api[_ -]?key)\s*[:=]\s*\S+|"
    r"(?:验证码|OTP|verification\s*code)\s*(?:是|为|[:：=])?\s*[0-9]{6}\b|"
    r"(?:邀请码|invite[_ -]?code)\s*(?:是|为|[:：=])?\s*[A-Za-z0-9_-]{16,}|"
    r"\bwenyan_beta_session\s*=\s*\S+|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,128}(?![A-Za-z0-9_-])|"
    r"(?<![0-9])[0-9]{6}(?![0-9]))", re.IGNORECASE)


def fail(code: str, status: int = 422):
    headers = {"Cache-Control": "no-store"}
    if code == "BETA_BUSY":
        headers["Retry-After"] = "2"
    raise HTTPException(status, {"code": code}, headers=headers)


def canonical_id(value: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        fail("SUPPORT_ADMIN_INVALID_INPUT")
    return value


def timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise ValueError("INVALID_TIMESTAMP")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise ValueError("INVALID_TIMESTAMP") from None


def stamp(value: str) -> str:
    return timestamp(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


class StatusInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    status: Status
    expected_updated_at: str = Field(max_length=40)

    @field_validator("expected_updated_at")
    @classmethod
    def valid_timestamp(cls, value):
        timestamp(value)
        return value


class ReplyInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(min_length=36, max_length=36)
    message: str = Field(min_length=10, max_length=2000)
    expected_updated_at: str = Field(max_length=40)
    status: Status | None = None

    @field_validator("request_id")
    @classmethod
    def valid_id(cls, value):
        return canonical_id(value)

    @field_validator("message", mode="before")
    @classmethod
    def valid_message(cls, value):
        if not isinstance(value, str):
            raise ValueError("INVALID_MESSAGE")
        value = value.strip()
        value.encode("utf-8")
        if any(ord(char) < 32 and char not in "\n\t" for char in value):
            raise ValueError("INVALID_MESSAGE")
        return value

    @field_validator("expected_updated_at")
    @classmethod
    def valid_timestamp(cls, value):
        timestamp(value)
        return value

    @model_validator(mode="after")
    def absent_not_null(self):
        if "status" in self.model_fields_set and self.status is None:
            raise ValueError("INVALID_STATUS")
        return self


def admin_guard(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    authorize_support(request, response)
    allowed = {"reference", "status", "kind", "offset", "limit"} if request.url.path == PREFIX and request.method == "GET" else set()
    seen = set()
    for key, value in request.query_params.multi_items():
        if key not in allowed or key in seen:
            fail("SUPPORT_ADMIN_INVALID_INPUT")
        seen.add(key)
        if key in {"offset", "limit"} and not re.fullmatch(r"0|[1-9][0-9]{0,4}", value):
            fail("SUPPORT_ADMIN_INVALID_INPUT")


router = APIRouter(prefix=PREFIX, dependencies=[Depends(admin_guard)])
Database = Annotated[Session, Depends(get_db)]


def metadata(row) -> dict:
    result = {key: row[key] for key in META_KEYS}
    # Bound and validate legacy rows before serializing them. Invalid storage
    # never returns raw errors or secret-containing exception values.
    if (str(UUID(result["id"])) != result["id"] or not REFERENCE.fullmatch(result["reference"])
            or result["kind"] not in KINDS or result["status"] not in STATES
            or result["category"] not in {"bug", "suggestion", "other"}
            or not isinstance(result["page"], str) or len(result["page"]) > 32
            or not isinstance(result["build_version"], str) or len(result["build_version"]) > 80):
        raise ValueError("INVALID_STORED_METADATA")
    result["created_at"] = stamp(result["created_at"])
    result["updated_at"] = stamp(result["updated_at"])
    return result


def storage_error(error):
    if isinstance(error, OperationalError):
        fail("BETA_BUSY", 503)
    fail("SUPPORT_ADMIN_STORAGE_ERROR", 503)


def detail(db: Session, feedback_id: str) -> dict:
    # Both case and bounded replies come from one SQLite statement/snapshot.
    rows = db.execute(text(f"""
        WITH owner_case AS (SELECT {META}, message, device FROM support_feedback WHERE id=:id),
        replies AS (SELECT id AS reply_id, message AS reply_message, created_at AS reply_created_at
                    FROM support_replies WHERE feedback_id=:id ORDER BY created_at, id LIMIT 21)
        SELECT owner_case.*, replies.* FROM owner_case LEFT JOIN replies ON 1=1
        ORDER BY reply_created_at, reply_id
    """), {"id": feedback_id}).mappings().all()
    if not rows:
        fail("SUPPORT_NOT_FOUND", 404)
    first = rows[0]
    replies = [row for row in rows if row["reply_id"] is not None]
    if len(replies) > 20:
        raise ValueError("INVALID_STORED_REPLIES")
    if (not isinstance(first["message"], str) or len(first["message"]) > 3000
            or not isinstance(first["device"], str) or len(first["device"]) > 120):
        raise ValueError("INVALID_STORED_CASE")
    values = []
    for row in replies:
        if (str(UUID(row["reply_id"])) != row["reply_id"] or not isinstance(row["reply_message"], str)
                or not 10 <= len(row["reply_message"]) <= 2000):
            raise ValueError("INVALID_STORED_REPLY")
        values.append({"id": row["reply_id"], "message": row["reply_message"], "created_at": stamp(row["reply_created_at"])})
    return {"item": metadata(first), "message": first["message"], "device": first["device"], "replies": values}


@router.get("")
def list_feedback(db: Database, reference: str = "", status: str = "", kind: str = "",
                  offset: int = Query(default=0, ge=0, le=10000), limit: int = Query(default=20, ge=1, le=50)):
    if ((reference and not REFERENCE.fullmatch(reference)) or (status and status not in STATES)
            or (kind and kind not in KINDS)):
        fail("SUPPORT_ADMIN_INVALID_INPUT")
    try:
        with db.no_autoflush:
            rows = db.execute(text(f"""
                WITH matching AS (SELECT {META} FROM support_feedback
                    WHERE (:reference='' OR reference=:reference) AND (:status='' OR status=:status)
                      AND (:kind='' OR kind=:kind)),
                totals AS (SELECT COUNT(*) AS total FROM matching),
                page AS (SELECT * FROM matching ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset)
                SELECT totals.total, page.* FROM totals LEFT JOIN page ON 1=1
                ORDER BY page.created_at DESC, page.id DESC
            """), {"reference": reference, "status": status, "kind": kind, "offset": offset, "limit": limit}).mappings().all()
        return {"items": [metadata(row) for row in rows if row["id"] is not None],
                "total": rows[0]["total"], "offset": offset, "limit": limit}
    except SQLAlchemyError as error:
        storage_error(error)
    except (ValueError, TypeError, AttributeError, OverflowError):
        fail("SUPPORT_ADMIN_DATA_INVALID", 503)


@router.get("/{feedback_id}")
def get_feedback(feedback_id: str, db: Database):
    canonical_id(feedback_id)
    try:
        with db.no_autoflush:
            return detail(db, feedback_id)
    except SQLAlchemyError as error:
        storage_error(error)
    except (ValueError, TypeError, AttributeError, OverflowError):
        fail("SUPPORT_ADMIN_DATA_INVALID", 503)


def begin_write(db):
    if db.get_bind().dialect.name != "sqlite":
        fail("SUPPORT_ADMIN_STORAGE_UNSUPPORTED", 503)
    db.execute(text("BEGIN IMMEDIATE"))


def check_case(db, feedback_id, expected):
    row = db.execute(text(f"SELECT {META} FROM support_feedback WHERE id=:id"), {"id": feedback_id}).mappings().first()
    if row is None:
        fail("SUPPORT_NOT_FOUND", 404)
    if expected is not None and timestamp(row["updated_at"]) != timestamp(expected):
        fail("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED", 409)
    return row


def update_case(db, row, status):
    next_time = max(datetime.now(timezone.utc), timestamp(row["updated_at"]) + timedelta(microseconds=1)).isoformat()
    result = db.execute(text("UPDATE support_feedback SET status=:status,updated_at=:next WHERE id=:id AND updated_at=:old"),
                        {"status": status, "next": next_time, "id": row["id"], "old": row["updated_at"]})
    if result.rowcount != 1:
        fail("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED", 409)
    return next_time


@router.post("/{feedback_id}/status")
def set_status(feedback_id: str, body: StatusInput, db: Database):
    canonical_id(feedback_id)
    try:
        begin_write(db)
        row = check_case(db, feedback_id, body.expected_updated_at)
        if row["status"] != body.status:
            update_case(db, row, body.status)
        result = detail(db, feedback_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        storage_error(error)
    except (ValueError, TypeError, AttributeError, OverflowError):
        db.rollback()
        fail("SUPPORT_ADMIN_DATA_INVALID", 503)


@router.post("/{feedback_id}/reply")
def reply(feedback_id: str, body: ReplyInput, db: Database):
    canonical_id(feedback_id)
    if SENSITIVE.search(body.message):
        fail("SUPPORT_REPLY_SENSITIVE_CONTENT")
    digest = hashlib.sha256(json.dumps({"message": body.message, "status": body.status},
                                      sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    try:
        begin_write(db)
        row = check_case(db, feedback_id, None)
        prior = db.execute(text("SELECT content_digest FROM support_replies WHERE feedback_id=:id AND request_id=:key"),
                           {"id": feedback_id, "key": body.request_id}).scalar_one_or_none()
        if prior is not None:
            if not isinstance(prior, str) or not hmac.compare_digest(prior, digest):
                fail("SUPPORT_REPLY_IDEMPOTENCY_CONFLICT", 409)
        else:
            if timestamp(row["updated_at"]) != timestamp(body.expected_updated_at):
                fail("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED", 409)
            count = db.execute(text("SELECT COUNT(*) FROM support_replies WHERE feedback_id=:id"), {"id": feedback_id}).scalar_one()
            if count >= 20:
                fail("SUPPORT_REPLY_CASE_LIMIT", 409)
            created_at = update_case(db, row, body.status or row["status"])
            db.execute(text("""INSERT INTO support_replies (id,feedback_id,request_id,content_digest,message,created_at)
                               VALUES (:id,:feedback_id,:key,:digest,:message,:created)"""),
                       {"id": str(uuid4()), "feedback_id": feedback_id, "key": body.request_id,
                        "digest": digest, "message": body.message, "created": created_at})
        result = detail(db, feedback_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        storage_error(error)
    except (ValueError, TypeError, AttributeError, OverflowError):
        db.rollback()
        fail("SUPPORT_ADMIN_DATA_INVALID", 503)
