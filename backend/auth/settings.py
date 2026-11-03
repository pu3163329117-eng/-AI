from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AccessSettings:
    mode: str
    production: bool
    admin_enabled: bool
    allowed_origins: tuple[str, ...]
    cookie_secure: bool
    login_method: str = "password"


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    if value.lower() not in {"true", "false", "1", "0", "on", "off"}:
        raise ValueError(f"{name} must be true/false, 1/0, or on/off")
    return value.lower() in {"true", "1", "on"}


def load_access_settings() -> AccessSettings:
    mode = os.getenv("WENYAN_ACCESS_MODE", "local").lower()
    environment = os.getenv("WENYAN_ENV", "development").lower()
    if environment not in {"development", "test", "production"}:
        raise ValueError("WENYAN_ENV must be development, test, or production")
    production = environment == "production" or bool(os.getenv("VERCEL"))
    login_method = os.getenv("WENYAN_AUTH_LOGIN_METHOD", "password").lower()
    if login_method not in {"password", "email_code"}:
        raise ValueError("WENYAN_AUTH_LOGIN_METHOD must be password or email_code")
    if mode not in {"local", "invite"}:
        raise ValueError("WENYAN_ACCESS_MODE must be local or invite")
    if production and mode != "invite":
        raise ValueError("Production requires WENYAN_ACCESS_MODE=invite")
    if mode == "invite":
        # The AI loader also reads the backend-only .env. Checking just os.environ
        # would miss an enabled local configuration accidentally copied to a host.
        try:
            from backend.ai.settings import load_settings as load_ai_settings
        except ModuleNotFoundError:
            from ai.settings import load_settings as load_ai_settings
        if (load_ai_settings().enabled or
                _boolean("WENYAN_COLLABORATION_ENABLED", False) or
                _boolean("WENYAN_COLLABORATION_REAL_CALLS_ENABLED", False)):
            raise ValueError("Invite beta requires AI and collaboration features to be disabled")
    origins = tuple(dict.fromkeys(x.strip() for x in os.getenv("WENYAN_AUTH_ORIGINS", "").split(",") if x.strip()))
    if mode == "invite" and not origins:
        raise ValueError("Invite mode requires explicit WENYAN_AUTH_ORIGINS")
    for origin in origins:
        parsed = urlsplit(origin)
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("Invalid authentication origin port") from error
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or
                parsed.password or parsed.path or parsed.query or parsed.fragment or
                "*" in origin or any(c.isspace() for c in origin) or "\\" in origin or
                parsed.netloc.endswith(":") or port == 0):
            raise ValueError("Authentication origins must be exact scheme://host[:port] origins")
        if production and parsed.scheme != "https":
            raise ValueError("Production authentication origins must use HTTPS")
    secure = _boolean("WENYAN_AUTH_COOKIE_SECURE", True)
    if not secure and (production or not origins or any(urlsplit(x).hostname not in {"127.0.0.1", "localhost", "::1"} for x in origins)):
        raise ValueError("Insecure authentication cookies are allowed only for explicit loopback origins")
    settings = AccessSettings(mode, production, _boolean("WENYAN_ADMIN_ENABLED", mode == "local"), origins, secure, login_method)
    if mode == "invite" and login_method == "email_code":
        from .email_service import email_configuration
        email_configuration(settings)
    return settings
