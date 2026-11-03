"""Read-only configuration checks plus an optional private storage write probe.

This is not a remote HTTPS/security audit and never prints environment values.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

if __package__:
    from .beta_backup import BackupError, checked_path
else:
    from backend.scripts.beta_backup import BackupError, checked_path


OFF = {"0", "false", "off"}
ON = {"1", "true", "on"}


def _origins_are_https(value: str) -> bool:
    origins = value.split(",")
    if not origins or any(not origin.strip() for origin in origins):
        return False
    for origin in origins:
        origin = origin.strip()
        try:
            parsed = urlsplit(origin)
            port = parsed.port
        except ValueError:
            return False
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or "*" in origin
                or "\\" in origin or any(char.isspace() for char in origin)
                or parsed.netloc.endswith(":") or port == 0):
            return False
    return True


def _temporary_roots() -> list[Path]:
    values = [Path(tempfile.gettempdir()), Path("/tmp"), Path("/var/tmp")]
    values.extend(Path(os.environ[key]) for key in ("TMP", "TEMP", "TMPDIR") if os.environ.get(key))
    return [path.resolve() for path in values if path.is_absolute()]


def _backend_ai_env_file() -> Path:
    return Path(__file__).resolve().parents[1] / ".env"


def _sqlite_path(env: dict[str, str]) -> Path:
    value = env.get("WENYAN_DATABASE_URL", "")
    if not value.startswith("sqlite:///"):
        raise BackupError("EXPLICIT_PERSISTENT_SQLITE_REQUIRED")
    raw = value[len("sqlite:///"):]
    if not raw or raw == ":memory:" or "?" in raw or "#" in raw:
        raise BackupError("EXPLICIT_PERSISTENT_SQLITE_REQUIRED")
    path = Path(raw)
    checked = checked_path(path, existing=path.exists())
    if any(checked == root or root in checked.parents for root in _temporary_roots()):
        raise BackupError("TEMPORARY_SQLITE_NOT_ALLOWED")
    return checked


def run_preflight(environ: dict[str, str] | None = None, *, check_storage: bool = True) -> dict:
    env = dict(os.environ if environ is None else environ)
    checks: list[dict] = []

    def add(code: str, passed: bool, action: str) -> None:
        checks.append({"check": code, "passed": passed, "action": "none" if passed else action})

    add("production_mode", env.get("WENYAN_ENV", "").lower() == "production", "Set WENYAN_ENV=production")
    add("invitation_access", env.get("WENYAN_ACCESS_MODE", "").lower() == "invite", "Set WENYAN_ACCESS_MODE=invite")
    add("email_code_login", env.get("WENYAN_AUTH_LOGIN_METHOD", "") == "email_code", "Set WENYAN_AUTH_LOGIN_METHOD=email_code")
    add("production_email_provider", env.get("WENYAN_AUTH_EMAIL_PROVIDER", "") == "resend", "Configure Resend; mock providers are forbidden in production")
    otp_secret = env.get("WENYAN_AUTH_OTP_SECRET", "")
    add("private_otp_secret", len(otp_secret.encode("utf-8")) >= 32 and not _placeholder(otp_secret), "Generate a unique private OTP HMAC secret of at least 32 bytes")
    resend_key = env.get("RESEND_API_KEY", "")
    add("resend_api_key", resend_key.startswith("re_") and len(resend_key) >= 20 and not any(c.isspace() for c in resend_key) and not _placeholder(resend_key), "Configure a restricted Resend sending API key in the private environment file")
    sender = env.get("WENYAN_AUTH_EMAIL_FROM", "")
    add("email_sender_address", _sender_address(sender), "Set a mailbox on your verified Resend sending domain; confirm SPF and DKIM externally")
    try:
        daily_limit = int(env.get("WENYAN_AUTH_EMAIL_DAILY_LIMIT", ""))
    except ValueError:
        daily_limit = 0
    add("email_daily_budget", 1 <= daily_limit <= 10000, "Set an explicit positive daily email quota within the purchased provider allowance")
    add("exact_https_origins", _origins_are_https(env.get("WENYAN_AUTH_ORIGINS", "")), "Set an explicit comma-separated HTTPS origin allowlist without paths or wildcards")
    add("secure_cookie", env.get("WENYAN_AUTH_COOKIE_SECURE", "").lower() in ON, "Explicitly enable secure authentication cookies")
    add("student_admin_disabled", env.get("WENYAN_ADMIN_ENABLED", "").lower() in OFF, "Disable management API routes in the student deployment")
    for name in ("WENYAN_AI_ENABLED", "WENYAN_COLLABORATION_ENABLED", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED"):
        add(name.lower(), env.get(name, "").lower() in OFF, f"Explicitly set {name}=0 for the first beta")
    try:
        if __package__ == "scripts":
            from ai.settings import load_settings as load_ai_settings
        else:
            from backend.ai.settings import load_settings as load_ai_settings
        ai_disabled = not load_ai_settings(environ=env, env_file=_backend_ai_env_file()).enabled
    except (ValueError, OSError):
        ai_disabled = False
    add("effective_ai_disabled", ai_disabled, "Validate backend AI settings and disable AI; backend/.env is read without exposing its contents")
    add("not_vercel_ephemeral_sqlite", not env.get("VERCEL"), "Use a persistent server volume, not a Vercel function SQLite file")
    database: Path | None = None
    try:
        database = _sqlite_path(env)
        add("durable_sqlite_path", True, "")
    except (BackupError, OSError, ValueError):
        add("durable_sqlite_path", False, "Use an absolute SQLite file path in an existing private persistent directory, not memory or a temporary directory")
    if check_storage:
        writable = False
        if database is not None:
            probe: str | None = None
            try:
                # No database connection, schema migration, or application data write.
                fd, probe = tempfile.mkstemp(prefix=".wenyan-preflight-", dir=database.parent)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(b"storage-probe\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                writable = not database.exists() or os.access(database, os.W_OK)
            except OSError:
                writable = False
            finally:
                if probe is not None:
                    Path(probe).unlink(missing_ok=True)
        add("private_storage_write_probe", writable, "Run as the service account and provide write access to the private database directory")
    else:
        checks.append({"check": "private_storage_write_probe", "passed": False, "action": "not run; repeat without --skip-storage-probe as the service account"})
    return {
        "configuration_checks_passed": all(check["passed"] for check in checks),
        "release_ready": False,
        "checks": checks,
        "manual_release_gates": [
            "Verify public HTTPS certificate, HTTP redirect, proxy cookie forwarding, and only approved forwarded headers",
            "Verify service account ACLs: database, WAL, backup and manifest are not web-served or in Git",
            "Run backup verify and offline restore rehearsal; confirm all restored sessions, invites and email challenges are revoked",
            "Verify Resend sender DNS, delivery to QQ/163/Gmail, provider account quota and failed-delivery handling; do not use real email during capacity tests",
            "Test unauthenticated, cross-user, student-management and AI/Harness-denied requests over the deployed API",
            "Verify the invitation-mode ASGI limiter holds at most 12 in-flight API requests, returns BETA_BUSY with Retry-After after its bounded queue, and leaves /api/health observable",
            "Measure capacity using synthetic users and set proxy body/rate limits plus operational alerts; 100 invited accounts is not a promise of 100 concurrent users",
            "Review lesson content, participant consent, rollback steps, backup retention and incident owner",
        ],
    }


def _placeholder(value: str) -> bool:
    lowered = value.lower()
    return not value.strip() or any(marker in lowered for marker in ("replace", "change_me", "changeme", "your_", "example", "placeholder", "do_not_use")) or len(set(value)) < 8


def _sender_address(value: str) -> bool:
    # Keep preflight free from auth model imports and database side effects.
    sender = value.lower()
    if not sender.isascii() or len(sender) > 254 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", sender):
        return False
    local, domain = sender.rsplit("@", 1)
    return (len(local) <= 64 and not local.startswith(".") and not local.endswith(".") and ".." not in local
            and all(len(label) <= 63 for label in domain.split("."))
            and not domain.endswith((".test", ".invalid", ".example")) and not _placeholder(sender))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Beta configuration preflight. Does not verify a remote server or grant release approval.")
    parser.add_argument("--skip-storage-probe", action="store_true")
    args = parser.parse_args(argv)
    result = run_preflight(check_storage=not args.skip_storage_probe)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["configuration_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
