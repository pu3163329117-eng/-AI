from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    from backend.db.session import get_db
    from backend.support_admin_access import support_available
except ModuleNotFoundError:
    from db.session import get_db
    from support_admin_access import support_available
from .models import AuthInvite, AuthSession, AuthUser, ProfileOwner, utcnow
from .service import COOKIE_NAME, SESSION_SECONDS, current_session, hash_password, new_session, normalize_username, rate_limit, require_csrf, require_origin, token_hash, verify_password
from .settings import AccessSettings, load_access_settings
from .email_service import consume_proof, normalize_email, request_proof

router = APIRouter(prefix="/api/v1/auth", tags=["beta-auth"])
Db = Annotated[Session, Depends(get_db)]


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=128)


class RedeemInput(LoginInput):
    invite_code: str = Field(min_length=16, max_length=256)


class EmailRequestInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    purpose: Literal["register", "login"]
    invite_code: str | None = Field(default=None, min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


class EmailVerifyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    challenge_id: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$")
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
    invite_code: str | None = Field(default=None, min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


def _enabled() -> AccessSettings:
    settings = load_access_settings()
    if settings.mode != "invite":
        raise HTTPException(404, "本地模式未启用邀请登录")
    return settings


def _payload(settings: AccessSettings, db: Session, pair: tuple[AuthUser, AuthSession] | None) -> dict:
    user, session = pair if pair else (None, None)
    owner = db.scalar(select(ProfileOwner).where(ProfileOwner.user_id == user.id)) if user else None
    return {"mode": settings.mode, "login_method": settings.login_method, "authenticated": user is not None,
            "user": {"id": user.id, "username": user.username, "role": user.role, "email": user.email} if user else None,
            "profile_id": owner.profile_id if owner else None,
            "csrf_token": session.csrf_token if session else None, "admin_enabled": settings.admin_enabled, "support_admin_enabled": support_available(user, settings)}


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def _set_cookie(response: Response, token: str, settings: AccessSettings) -> None:
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True, secure=settings.cookie_secure, samesite="lax", path="/")
    _no_store(response)


@router.get("/session")
def session_info(request: Request, response: Response, db: Db):
    settings = load_access_settings()
    _no_store(response)
    return _payload(settings, db, current_session(request, db, settings))


@router.post("/redeem")
def redeem(body: RedeemInput, request: Request, response: Response, db: Db):
    settings = _enabled()
    if settings.login_method != "password":
        raise HTTPException(404, {"code": "AUTH_LOGIN_METHOD_DISABLED"})
    require_origin(request, settings)
    rate_limit(db, request, "redeem")
    try:
        username = normalize_username(body.username)
        password_hash = hash_password(body.password)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    now = utcnow()
    # Conditional UPDATE is the consumption lock. A duplicate user or any later
    # failure rolls the whole transaction back, leaving the invitation unconsumed.
    invite = db.execute(update(AuthInvite).where(AuthInvite.token_hash == token_hash(body.invite_code),
        AuthInvite.used_at.is_(None), AuthInvite.revoked_at.is_(None), AuthInvite.expires_at > now,
        AuthInvite.email.is_(None),
        AuthInvite.role.in_(["learner", "admin"])).values(used_at=now).returning(AuthInvite)).scalar_one_or_none()
    if invite is None:
        db.rollback()
        raise HTTPException(400, "邀请码无效或已失效")
    user = AuthUser(username=username, password_hash=password_hash, role=invite.role)
    db.add(user)
    try:
        db.flush()
        invite.used_by = user.id
        old = current_session(request, db, settings)
        if old:
            old[1].revoked_at = now
        token, session = new_session(db, user)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "无法创建账号，请更换用户名或检查邀请") from None
    _set_cookie(response, token, settings)
    return _payload(settings, db, (user, session))


@router.post("/login")
def login(body: LoginInput, request: Request, response: Response, db: Db):
    settings = _enabled()
    if settings.login_method != "password":
        raise HTTPException(404, {"code": "AUTH_LOGIN_METHOD_DISABLED"})
    require_origin(request, settings)
    try:
        username = normalize_username(body.username)
    except ValueError:
        username = ""
    rate_limit(db, request, "login", username)
    user = db.scalar(select(AuthUser).where(AuthUser.username == username))
    valid = verify_password(body.password, user.password_hash if user else None)
    if not valid or not user or user.disabled:
        raise HTTPException(401, "用户名或密码错误")
    old = current_session(request, db, settings)
    if old:
        old[1].revoked_at = utcnow()
    token, session = new_session(db, user)
    db.commit()
    _set_cookie(response, token, settings)
    return _payload(settings, db, (user, session))


def _email_enabled(request: Request) -> AccessSettings:
    settings = _enabled()
    if settings.login_method != "email_code":
        raise HTTPException(404, {"code": "AUTH_LOGIN_METHOD_DISABLED"})
    require_origin(request, settings)
    return settings


def _email(value: str) -> str:
    try:
        return normalize_email(value)
    except ValueError:
        raise HTTPException(422, {"code": "AUTH_INVALID_INPUT", "message": "请输入有效邮箱地址"}) from None


@router.post("/email/request")
def email_request(body: EmailRequestInput, request: Request, response: Response, db: Db):
    settings = _email_enabled(request)
    result = request_proof(db, request, settings, _email(body.email), body.purpose, body.invite_code)
    _no_store(response)
    return result


@router.post("/email/verify")
def email_verify(body: EmailVerifyInput, request: Request, response: Response, db: Db):
    settings = _email_enabled(request)
    user = consume_proof(db, request, settings, _email(body.email), body.challenge_id, body.code, body.invite_code)
    old = current_session(request, db, settings)
    if old:
        old[1].revoked_at = utcnow()
    token, session = new_session(db, user)
    db.commit()
    _set_cookie(response, token, settings)
    return _payload(settings, db, (user, session))


@router.post("/logout")
def logout(request: Request, response: Response, db: Db):
    settings = _enabled()
    pair = current_session(request, db, settings)
    if pair is None:
        require_origin(request, settings)
        raise HTTPException(401, "请先登录")
    require_csrf(request, pair[1], settings)
    pair[1].revoked_at = utcnow()
    db.commit()
    response.delete_cookie(COOKIE_NAME, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax")
    _no_store(response)
    return {"ok": True}
