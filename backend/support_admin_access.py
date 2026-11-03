"""Narrow owner-only feedback capability, independent of teaching admin.

The global access guard supplies its real, current database user; the router
then rechecks the trusted request state without opening another transaction.
This module never changes roles, sessions, configuration, or data.
"""
from __future__ import annotations

import os
import re
from typing import Mapping
from uuid import UUID

from fastapi import HTTPException, Request, Response

try:
    from backend.auth.settings import load_access_settings
except ModuleNotFoundError:
    from auth.settings import load_access_settings


SUPPORT_OWNER_EMAIL_ENV = "WENYAN_SUPPORT_OWNER_EMAIL"
PREFIX = "/api/v1/admin/support/feedback"
_CASE_ROUTE = re.compile(re.escape(PREFIX) + r"/([0-9a-f-]{36})(?:/(status|reply))?\Z")


def support_enabled(environ: Mapping[str, str] | None = None) -> bool:
    values = os.environ if environ is None else environ
    value = values.get("WENYAN_SUPPORT_ADMIN_ENABLED", "false")
    if not isinstance(value, str) or value.lower() not in {"true", "false", "1", "0", "on", "off"}:
        raise ValueError("SUPPORT_ACCESS_CONFIGURATION_INVALID")
    return value.lower() in {"true", "1", "on"}


def is_support_route(method: str, path: str) -> bool:
    """Only the four reviewed actions; never a generic admin-prefix bypass."""
    if method == "GET" and path == PREFIX:
        return True
    match = _CASE_ROUTE.fullmatch(path)
    if match is None:
        return False
    try:
        if str(UUID(match[1])) != match[1]:
            return False
    except ValueError:
        return False
    return (method == "GET" and match[2] is None) or (method == "POST" and match[2] in {"status", "reply"})


def _support_owner_email() -> str:
    """Read exactly one valid owner, dynamically; never expose the configured value."""
    try:
        from backend.auth.email_service import normalize_email
    except ModuleNotFoundError:
        from auth.email_service import normalize_email
    value = os.environ.get(SUPPORT_OWNER_EMAIL_ENV)
    if value is None:
        raise ValueError("SUPPORT_ACCESS_CONFIGURATION_INVALID")
    try:
        return normalize_email(value)
    except (TypeError, ValueError):
        raise ValueError("SUPPORT_ACCESS_CONFIGURATION_INVALID") from None


def support_available(user, settings=None) -> bool:
    """Per-session capability, not the general admin switch or role alone."""
    try:
        settings = settings or load_access_settings()
    except ValueError:
        _deny("ACCESS_CONFIGURATION_INVALID", 503)
    try:
        enabled = support_enabled()
        owner_email = _support_owner_email() if enabled else None
    except ValueError:
        return False
    return bool(enabled and settings.mode == "invite" and user is not None
                and getattr(user, "email", None) == owner_email
                and getattr(user, "role", None) == "admin"
                and getattr(user, "disabled", None) is False)


def _deny(code: str, status: int):
    raise HTTPException(status, {"code": code}, headers={"Cache-Control": "no-store"})


def authorize_support(request: Request, response: Response | None = None, settings=None, *, user=None) -> None:
    if response is not None:
        response.headers["Cache-Control"] = "no-store"
    # A state value from an earlier guard must never survive a failed fresh
    # identity/configuration check within this request.
    if user is not None:
        request.state.auth_support_admin = False
    if not is_support_route(request.method, request.url.path):
        _deny("SUPPORT_ROUTE_UNAVAILABLE", 404)
    try:
        settings = settings or load_access_settings()
        enabled = support_enabled()
        if enabled:
            _support_owner_email()
    except ValueError:
        _deny("ACCESS_CONFIGURATION_INVALID", 503)
    if not enabled:
        _deny("ADMIN_DISABLED", 404)
    if settings.mode != "invite" or not getattr(request.state, "auth_user_id", None):
        _deny("AUTH_REQUIRED", 401)
    if getattr(request.state, "auth_role", None) != "admin":
        _deny("ADMIN_REQUIRED", 403)
    if user is not None:
        try:
            allowed = support_available(user, settings)
        except ValueError:
            _deny("ACCESS_CONFIGURATION_INVALID", 503)
        # Bind the global guard's live identity to the same authenticated state,
        # not a merely similar email object supplied by another application.
        allowed = allowed and getattr(user, "id", None) == request.state.auth_user_id
        request.state.auth_support_admin = bool(allowed)
    if getattr(request.state, "auth_support_admin", False) is not True:
        _deny("SUPPORT_ADMIN_REQUIRED", 403)
