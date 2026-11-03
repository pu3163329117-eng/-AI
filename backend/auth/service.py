from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import AuthAttempt, AuthInvite, AuthSession, AuthUser, utcnow
from .settings import AccessSettings, load_access_settings

COOKIE_NAME = "wenyan_beta_session"
SESSION_SECONDS = 12 * 60 * 60
_HASH_SLOTS = threading.BoundedSemaphore(2)


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_username(value: str) -> str:
    if not value.isascii():
        raise ValueError("用户名仅支持英文字母、数字、点、短横线或下划线")
    value = value.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,39}", value, flags=re.ASCII):
        raise ValueError("用户名需为 3–40 位英文字母、数字、点、短横线或下划线")
    return value


def _derive(password: str, salt: bytes) -> bytes:
    if not _HASH_SLOTS.acquire(blocking=False):
        raise HTTPException(503, "认证繁忙，请稍后重试", headers={"Retry-After": "3"})
    try:
        return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**17, r=8, p=1, dklen=32, maxmem=256*1024*1024)
    finally:
        _HASH_SLOTS.release()


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 128:
        raise ValueError("密码长度需为 12–128 位")
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("密码包含不支持的字符") from None
    salt = secrets.token_bytes(16)
    return f"scrypt$131072$8$1${salt.hex()}${_derive(password, salt).hex()}"


def verify_password(password: str, encoded: str | None) -> bool:
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        password, encoded = "invalid-unicode-password", None
    salt, expected, valid = b"wenyan-dummy-v1!", bytes(32), False
    if encoded:
        try:
            scheme, n, r, p, salt_hex, digest = encoded.split("$")
            if (scheme, n, r, p) == ("scrypt", "131072", "8", "1"):
                salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(digest)
                valid = len(salt) == 16 and len(expected) == 32
        except (ValueError, TypeError):
            pass
    actual = _derive(password, salt)
    return hmac.compare_digest(actual, expected) and valid


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def current_session(request: Request, db: Session, settings: AccessSettings | None = None) -> tuple[AuthUser, AuthSession] | None:
    settings = settings or load_access_settings()
    token = request.cookies.get(COOKIE_NAME, "")
    if settings.mode != "invite" or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return None
    result = db.execute(select(AuthUser, AuthSession).join(AuthSession, AuthSession.user_id == AuthUser.id).where(
        AuthSession.token_hash == token_hash(token), AuthSession.revoked_at.is_(None), AuthUser.disabled.is_(False)
    )).first()
    if result is None or aware(result[1].expires_at) <= utcnow():
        return None
    return result[0], result[1]


def require_origin(request: Request, settings: AccessSettings) -> None:
    if request.headers.get("origin") not in settings.allowed_origins:
        raise HTTPException(403, "请求来源未获授权")


def require_csrf(request: Request, auth_session: AuthSession, settings: AccessSettings) -> None:
    require_origin(request, settings)
    supplied = request.headers.get("x-csrf-token", "")
    try:
        valid = bool(supplied) and hmac.compare_digest(supplied.encode("utf-8"), auth_session.csrf_token.encode("utf-8"))
    except UnicodeEncodeError:
        valid = False
    if not valid:
        raise HTTPException(403, "安全校验失败，请刷新后重试")


def rate_limit(db: Session, request: Request, action: str, username: str = "") -> None:
    # Never trust Forwarded/X-Forwarded-For supplied by a caller. Proxy deployments
    # must additionally apply edge limits; the direct peer bucket is conservative.
    peer = request.client.host if request.client else "unknown"
    bucket = int(time.time()) // 900
    subjects = [(f"{action}:global", 100 if action == "login" else 50),
                (f"{action}:ip:{peer}", 30 if action == "login" else 20)]
    if username:
        subjects.append((f"{action}:user:{username}", 10))
    for subject, ceiling in subjects:
        key = f"{bucket}:{token_hash(subject)}"
        values = {"attempts": AuthAttempt.attempts + 1}
        count = db.execute(update(AuthAttempt).where(AuthAttempt.key == key).values(**values).returning(AuthAttempt.attempts)).scalar_one_or_none()
        if count is None:
            db.add(AuthAttempt(key=key, attempts=1, expires_at=utcnow()+timedelta(minutes=30)))
            try:
                db.commit()
                count = 1
            except IntegrityError:
                db.rollback()
                count = db.execute(update(AuthAttempt).where(AuthAttempt.key == key).values(**values).returning(AuthAttempt.attempts)).scalar_one()
                db.commit()
        else:
            db.commit()
        if count > ceiling:
            raise HTTPException(429, "尝试次数过多，请稍后重试", headers={"Retry-After": str(900-int(time.time()) % 900)})


def new_session(db: Session, user: AuthUser) -> tuple[str, AuthSession]:
    token = secrets.token_urlsafe(32)
    session = AuthSession(token_hash=token_hash(token), user_id=user.id, csrf_token=secrets.token_urlsafe(32), expires_at=utcnow()+timedelta(seconds=SESSION_SECONDS))
    db.add(session)
    return token, session


def create_invite(db: Session, *, role: str, expires_hours: int = 72, email: str | None = None) -> tuple[str, AuthInvite]:
    if role not in {"learner", "admin"} or not 1 <= expires_hours <= 168:
        raise ValueError("邀请码角色或有效期不合法（最长 168 小时）")
    if email is not None:
        from .email_service import normalize_email
        email = normalize_email(email)
    token = secrets.token_urlsafe(32)
    invite = AuthInvite(token_hash=token_hash(token), role=role, email=email, expires_at=utcnow()+timedelta(hours=expires_hours))
    db.add(invite)
    db.commit()
    return token, invite
