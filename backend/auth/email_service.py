"""Bounded email proofs. No OTP, invitation or provider key is logged."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import timedelta

from fastapi import HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import AuthAttempt, AuthEmailChallenge, AuthInvite, AuthUser, utcnow
from .service import aware, token_hash
from .settings import AccessSettings

OTP_SECONDS = 600
COOLDOWN_SECONDS = 60
INVALID_PROOF = {"code": "AUTH_EMAIL_CODE_INVALID", "message": "验证码或邀请无效、已失效，请重新获取"}
UNAVAILABLE = {"code": "AUTH_EMAIL_UNAVAILABLE", "message": "邮件服务暂不可用，请稍后重试"}
RATE_LIMITED = {"code": "AUTH_EMAIL_RATE_LIMITED", "message": "请求过于频繁，请稍后重试"}


def _placeholder(value: str) -> bool:
    """Reject committed examples even when startup bypasses deployment preflight."""
    lowered = value.strip().lower()
    markers = ("replace", "change_me", "changeme", "your_", "example", "placeholder", "do_not_use")
    return not lowered or any(marker in lowered for marker in markers) or len(set(value)) < 8


@dataclass(frozen=True)
class EmailConfiguration:
    provider: str
    secret: bytes = field(repr=False)
    sender: str
    api_key: str = field(repr=False)
    daily_limit: int


def normalize_email(value: str) -> str:
    value = value.strip().lower()
    if (not value.isascii() or len(value) > 254 or value.count("@") != 1 or
            not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", value)):
        raise ValueError("请输入有效邮箱地址")
    local, domain = value.rsplit("@", 1)
    if len(local) > 64 or local.startswith(".") or local.endswith(".") or ".." in local or any(len(label) > 63 for label in domain.split(".")):
        raise ValueError("请输入有效邮箱地址")
    return value


def email_configuration(settings: AccessSettings) -> EmailConfiguration:
    provider = os.getenv("WENYAN_AUTH_EMAIL_PROVIDER", "resend").lower()
    secret = os.getenv("WENYAN_AUTH_OTP_SECRET", "").encode("utf-8")
    if provider not in {"resend", "mock"} or len(secret) < 32:
        raise ValueError("Email authentication requires a supported provider and an OTP secret of at least 32 bytes")
    if provider == "mock" and settings.production:
        raise ValueError("Mock email is prohibited in production")
    sender = os.getenv("WENYAN_AUTH_EMAIL_FROM", "")
    api_key = os.getenv("RESEND_API_KEY", "")
    if provider == "resend":
        try:
            sender = normalize_email(sender)
        except ValueError:
            raise ValueError("Email authentication requires a verified sender address") from None
        if not api_key.strip() or any(c.isspace() for c in api_key):
            raise ValueError("Email authentication requires the server-side Resend API key")
        if settings.production:
            sender_domain = sender.rsplit("@", 1)[1]
            if (_placeholder(secret.decode("utf-8", errors="ignore")) or
                    not api_key.startswith("re_") or len(api_key) < 20 or _placeholder(api_key) or
                    sender_domain.endswith((".test", ".invalid", ".example")) or _placeholder(sender)):
                raise ValueError("Production email authentication requires private non-placeholder credentials and sender")
    try:
        daily_limit = int(os.getenv("WENYAN_AUTH_EMAIL_DAILY_LIMIT", "80"))
    except ValueError:
        raise ValueError("Email daily limit must be an integer between 1 and 10000") from None
    if not 1 <= daily_limit <= 10000:
        raise ValueError("Email daily limit must be between 1 and 10000")
    return EmailConfiguration(provider, secret, sender, api_key, daily_limit)


def _digest(config: EmailConfiguration, challenge_id: str, email: str, purpose: str, code: str) -> str:
    return hmac.new(config.secret, f"otp-v1\0{challenge_id}\0{email}\0{purpose}\0{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def _counter(db: Session, subject: str, ceiling: int, seconds: int) -> None:
    bucket = int(time.time()) // seconds
    key = f"{bucket}:{token_hash('email:' + subject)}"
    count = db.execute(update(AuthAttempt).where(AuthAttempt.key == key).values(attempts=AuthAttempt.attempts+1).returning(AuthAttempt.attempts)).scalar_one_or_none()
    if count is None:
        db.add(AuthAttempt(key=key, attempts=1, expires_at=utcnow()+timedelta(seconds=seconds*2)))
        try:
            db.commit()
            count = 1
        except IntegrityError:
            db.rollback()
            count = db.execute(update(AuthAttempt).where(AuthAttempt.key == key).values(attempts=AuthAttempt.attempts+1).returning(AuthAttempt.attempts)).scalar_one()
            db.commit()
    else:
        db.commit()
    if count > ceiling:
        raise HTTPException(429, RATE_LIMITED, headers={"Retry-After": str(seconds-int(time.time()) % seconds)})


def _cooldown(db: Session, email: str) -> None:
    key, now = "cooldown:" + token_hash(email), utcnow()
    changed = db.execute(update(AuthAttempt).where(AuthAttempt.key == key, AuthAttempt.expires_at <= now).values(attempts=1, expires_at=now+timedelta(seconds=COOLDOWN_SECONDS)).execution_options(synchronize_session=False)).rowcount
    if changed:
        db.commit()
        return
    existing = db.get(AuthAttempt, key)
    if existing is not None:
        db.rollback()
        raise HTTPException(429, RATE_LIMITED, headers={"Retry-After": str(COOLDOWN_SECONDS)})
    db.add(AuthAttempt(key=key, attempts=1, expires_at=now+timedelta(seconds=COOLDOWN_SECONDS)))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(429, RATE_LIMITED, headers={"Retry-After": str(COOLDOWN_SECONDS)}) from None


def send_code(config: EmailConfiguration, request: Request, email: str, code: str, challenge_id: str) -> None:
    """Tests replace this function. Mock never logs or returns the code to HTTP."""
    if config.provider == "mock":
        if not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
            raise HTTPException(503, UNAVAILABLE)
        return
    payload = json.dumps({"from": config.sender, "to": [email], "subject": "文言·推理登录验证码",
        "text": f"你的验证码为 {code}，10 分钟内有效。请勿转发给他人。如非本人操作，请忽略此邮件。"}).encode("utf-8")
    outgoing = urllib.request.Request("https://api.resend.com/emails", data=payload, method="POST", headers={
        "Authorization": "Bearer " + config.api_key, "Content-Type": "application/json", "User-Agent": "wenyan-beta/1.0", "Idempotency-Key": "wenyan-otp-"+challenge_id})
    try:
        # Refuse redirects: never forward a provider credential to another origin.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect()).open(outgoing, timeout=5) as result:
            if result.status not in {200, 201, 202}:
                raise ValueError("provider rejected email")
            receipt = json.loads(result.read(65536))
            if not isinstance(receipt, dict) or not isinstance(receipt.get("id"), str) or not receipt["id"]:
                raise ValueError("provider response invalid")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise HTTPException(503, UNAVAILABLE) from None


def _valid_invite(db: Session, email: str, code: str | None) -> AuthInvite | None:
    if not code:
        return None
    return db.scalar(select(AuthInvite).where(AuthInvite.token_hash == token_hash(code),
        AuthInvite.used_at.is_(None), AuthInvite.revoked_at.is_(None), AuthInvite.expires_at > utcnow(),
        AuthInvite.role.in_(["learner", "admin"]), ((AuthInvite.email.is_(None)) | (AuthInvite.email == email))))


def request_proof(db: Session, request: Request, settings: AccessSettings, email: str, purpose: str, invite_code: str | None) -> dict:
    config = email_configuration(settings)
    if config.provider == "mock" and (not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}):
        raise HTTPException(503, UNAVAILABLE)
    peer = request.client.host if request.client else "unknown"
    _counter(db, "request:global", 300, 900)
    _counter(db, "request:peer:"+peer, 200, 900)
    _counter(db, "request:email:"+email, 5, 3600)
    _cooldown(db, email)
    user = db.scalar(select(AuthUser).where(AuthUser.email == email, AuthUser.disabled.is_(False)))
    invite = _valid_invite(db, email, invite_code) if purpose == "register" else None
    deliverable = (user is not None) if purpose == "login" else (user is None and invite is not None)
    if deliverable:
        try:
            _counter(db, "send:global", config.daily_limit, 86400)
        except HTTPException as error:
            if error.status_code != 429:
                raise
            # Provider capacity is not an identity oracle. Once the daily sending
            # budget is exhausted, a real account receives the same decoy proof
            # as an unknown address instead of a distinguishing HTTP status.
            deliverable = False
    challenge_id, code, now = secrets.token_urlsafe(32), f"{secrets.randbelow(1000000):06d}", utcnow()
    db.execute(update(AuthEmailChallenge).where(AuthEmailChallenge.email == email, AuthEmailChallenge.revoked_at.is_(None), AuthEmailChallenge.consumed_at.is_(None)).values(revoked_at=now))
    row = AuthEmailChallenge(id=challenge_id, email=email, purpose=purpose, code_digest=_digest(config, challenge_id, email, purpose, code),
        invite_id=invite.id if invite else None, expires_at=now+timedelta(seconds=OTP_SECONDS), deliverable=deliverable)
    db.add(row)
    db.commit()
    if deliverable:
        try:
            send_code(config, request, email, code, challenge_id)
        except Exception:
            row.revoked_at = utcnow()
            db.commit()
            raise HTTPException(503, UNAVAILABLE) from None
        row.sent_at = utcnow()
        db.commit()
    return {"ok": True, "challenge_id": challenge_id, "expires_in_seconds": OTP_SECONDS, "resend_after_seconds": COOLDOWN_SECONDS}


def consume_proof(db: Session, request: Request, settings: AccessSettings, email: str, challenge_id: str, code: str, invite_code: str | None) -> AuthUser:
    config = email_configuration(settings)
    if config.provider == "mock" and (not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}):
        raise HTTPException(503, UNAVAILABLE)
    peer = request.client.host if request.client else "unknown"
    _counter(db, "verify:global", 1200, 900)
    _counter(db, "verify:peer:"+peer, 800, 900)
    _counter(db, "verify:email:"+email, 20, 900)
    now = utcnow()
    row = db.execute(update(AuthEmailChallenge).where(AuthEmailChallenge.id == challenge_id,
        AuthEmailChallenge.email == email, AuthEmailChallenge.expires_at > now, AuthEmailChallenge.revoked_at.is_(None),
        AuthEmailChallenge.consumed_at.is_(None), AuthEmailChallenge.attempts < 5).values(attempts=AuthEmailChallenge.attempts+1).returning(AuthEmailChallenge).execution_options(synchronize_session=False)).scalar_one_or_none()
    if row is None:
        db.rollback()
        raise HTTPException(400, INVALID_PROOF)
    valid = hmac.compare_digest(row.code_digest, _digest(config, row.id, email, row.purpose, code))
    if not valid or not row.deliverable or row.sent_at is None:
        db.commit()
        raise HTTPException(400, INVALID_PROOF)
    if row.purpose == "register":
        invite = _valid_invite(db, email, invite_code)
        if invite is None or invite.id != row.invite_id:
            db.commit()
            raise HTTPException(400, INVALID_PROOF)
        reserved = db.execute(update(AuthInvite).where(AuthInvite.id == invite.id, AuthInvite.used_at.is_(None),
            AuthInvite.revoked_at.is_(None), AuthInvite.expires_at > now,
            ((AuthInvite.email.is_(None)) | (AuthInvite.email == email))).values(used_at=now).returning(AuthInvite.id).execution_options(synchronize_session=False)).scalar_one_or_none()
        if reserved is None:
            db.rollback()
            raise HTTPException(400, INVALID_PROOF)
        user = AuthUser(username="mail_"+secrets.token_hex(16), email=email, password_hash="email-code-only", role=invite.role)
        db.add(user)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise HTTPException(400, INVALID_PROOF) from None
        invite.used_by = user.id
    else:
        user = db.scalar(select(AuthUser).where(AuthUser.email == email, AuthUser.disabled.is_(False)))
        if user is None:
            db.commit()
            raise HTTPException(400, INVALID_PROOF)
    row.consumed_at = now
    # Caller adds the rotated session then commits the whole proof/account/invite.
    return user
