"""Private, bounded beta operations checks. Never logs email, keys or user rows.

Run from the application directory. No .env discovery, public HTTP endpoint,
cloud API or application imports. Synthetic mode never reads a live DB or key.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit

UNITS = ("wenyan-beta.service", "wenyan-beta-backup.service", "wenyan-beta-offsite.service")
CODES = frozenset({"HEALTH_UNREACHABLE", "LOCAL_BACKUP_STALE", "OFFSITE_BACKUP_STALE",
    "DISK_LOW", "EMAIL_BUDGET_LOW", "EMAIL_BUDGET_UNREADABLE", "SERVICE_FAILED",
    "BACKUP_FAILED", "OFFSITE_FAILED", "OPS_STATE_INVALID"})


def _timestamp(value: object) -> float:
    if not isinstance(value, str):
        raise ValueError("INVALID_TIMESTAMP")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("TIMESTAMP_TIMEZONE_REQUIRED")
    return parsed.timestamp()


def _private_path(path: Path, *, parent_required: bool = True) -> Path:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("ABSOLUTE_PATH_REQUIRED")
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise ValueError("LINK_NOT_ALLOWED")
    if parent_required and not path.parent.is_dir():
        raise ValueError("PARENT_REQUIRED")
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise ValueError("REGULAR_FILE_REQUIRED")
    return path


def _read_json(path: Path, limit: int = 65536) -> dict:
    _private_path(path)
    if path.stat().st_size > limit:
        raise ValueError("JSON_TOO_LARGE")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON_OBJECT_REQUIRED")
    return value


def _write_json(path: Path, value: dict) -> None:
    _private_path(path)
    temporary = path.with_name(path.name + ".new-" + secrets.token_hex(8))
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def _lock(path: Path):
    """OS lock survives crashes without an indefinitely stale exclusive marker."""
    _private_path(path)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            os.write(descriptor, b"0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def email_budget(database: Path, now: float, limit: int) -> dict:
    """Read exactly one aggregate counter; never query email or learning tables."""
    _private_path(database)
    bucket = int(now) // 86400
    hashed = hashlib.sha256(b"email:send:global").hexdigest()
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        row = connection.execute("SELECT attempts FROM auth_attempts WHERE key = ?", (f"{bucket}:{hashed}",)).fetchone()
    used = max(0, int(row[0])) if row else 0
    return {"otp_attempts": used, "otp_limit": limit, "otp_remaining": max(0, limit - used)}


def _fresh_backup(directory: Path, now: float, hours: int) -> bool:
    # A successful manifest is written only after SQLite checks. Validate its
    # file hash here too, without opening user records or copying the live DB.
    try:
        if directory.is_symlink() or not directory.is_dir():
            return False
        candidates = sorted(directory.glob("*.db.manifest.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:8]
        for manifest in candidates:
            report = _read_json(manifest, 1_048_576)
            stamp = _timestamp(report.get("created_at_utc"))
            database = _private_path(Path(str(manifest).removesuffix(".manifest.json")))
            if (report.get("format") != "wenyan-sqlite-backup-v1" or
                    report.get("integrity") != "ok" or report.get("foreign_keys") != "ok" or
                    not -300 <= now - stamp <= hours * 3600 or
                    report.get("database_size_bytes") != database.stat().st_size):
                continue
            with database.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if secrets.compare_digest(str(report.get("database_sha256", "")), digest):
                return True
        return False
    except (OSError, ValueError, TypeError):
        return False


def _fresh_offsite(receipt: Path, now: float, hours: int) -> bool:
    try:
        report = _read_json(receipt)
        stamp = _timestamp(report.get("completed_at_utc"))
        return (report.get("format") == "wenyan-offsite-receipt-v1" and
                report.get("status") == "ok" and -300 <= now - stamp <= hours * 3600 and
                bool(re.fullmatch(r"[a-f0-9]{64}", str(report.get("backup_sha256", "")))) and
                bool(re.fullmatch(r"[a-f0-9]{64}", str(report.get("cipher_sha256", "")))) and
                type(report.get("cipher_size_bytes")) is int and report["cipher_size_bytes"] > 0)
    except (OSError, ValueError, TypeError):
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect(config: dict, now: float) -> tuple[list[str], dict]:
    findings, metrics = [], {}
    health = urlsplit(config["health_url"])
    if (health.scheme != "http" or health.hostname != "127.0.0.1" or health.port != 8000 or
            health.path != "/api/health" or health.query or health.fragment or health.username or health.password):
        raise ValueError("LOOPBACK_HEALTH_URL_REQUIRED")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect()).open(config["health_url"], timeout=3) as response:
            if response.status != 200:
                findings.append("HEALTH_UNREACHABLE")
    except (OSError, ValueError):
        findings.append("HEALTH_UNREACHABLE")
    if not _fresh_backup(config["backup_dir"], now, config["backup_hours"]):
        findings.append("LOCAL_BACKUP_STALE")
    if not _fresh_offsite(config["offsite_receipt"], now, config["backup_hours"]):
        findings.append("OFFSITE_BACKUP_STALE")
    try:
        disk = shutil.disk_usage(config["disk_path"])
        metrics["disk_free_mib"] = disk.free // 1024**2
        metrics["disk_free_percent"] = round(100 * disk.free / disk.total, 1)
        if disk.free < config["disk_min_mib"] * 1024**2 or disk.free / disk.total < .1:
            findings.append("DISK_LOW")
    except OSError:
        findings.append("DISK_LOW")
    try:
        metrics.update(email_budget(config["database"], now, config["otp_limit"]))
        if metrics["otp_remaining"] <= config["otp_warning"]:
            findings.append("EMAIL_BUDGET_LOW")
    except (OSError, ValueError, sqlite3.Error):
        findings.append("EMAIL_BUDGET_UNREADABLE")
    for unit, code in zip(UNITS, ("SERVICE_FAILED", "BACKUP_FAILED", "OFFSITE_FAILED")):
        try:
            result = subprocess.run(["systemctl", "is-failed", unit], capture_output=True, timeout=3, text=True)
            if result.stdout.strip() == "failed":
                findings.append(code)
        except (OSError, subprocess.TimeoutExpired):
            findings.append(code)
    return sorted(set(findings)), metrics


def _address(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", value))


def send_alert(config: dict, event: str, findings: list[str], metrics: dict, stamp: float) -> None:
    # Private configuration is intentionally never included in the return value,
    # exceptions, state, journal or operational message body.
    sender, recipient, key = config["sender"], config["recipient"], config["api_key"]
    if not _address(sender) or not _address(recipient) or not key or any(c.isspace() for c in key):
        raise ValueError("ALERT_PRIVATE_CONFIGURATION_REQUIRED")
    details = {key: value for key, value in metrics.items()
               if key in {"disk_free_mib", "disk_free_percent", "otp_attempts", "otp_limit", "otp_remaining"}
               and type(value) in {int, float}}
    payload = json.dumps({"from": sender, "to": [recipient],
        "subject": "Wenyan beta operations " + event,
        "text": json.dumps({"event": event, "utc": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                            "findings": [code for code in findings if code in CODES], "metrics": details})}).encode()
    identity = hashlib.sha256(f"{event}:{','.join(findings)}:{int(stamp)}".encode()).hexdigest()
    request = urllib.request.Request("https://api.resend.com/emails", data=payload, method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "User-Agent": "wenyan-beta-ops/1.0",
                 "Idempotency-Key": "wenyan-ops-" + identity})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect()).open(request, timeout=5) as response:
        receipt = json.loads(response.read(65536))
        if (response.status not in {200, 201, 202} or not isinstance(receipt, dict) or
                not isinstance(receipt.get("id"), str) or not receipt["id"]):
            raise ValueError("ALERT_DELIVERY_FAILED")


def process(config: dict, findings: list[str], metrics: dict, now: float, *, synthetic: bool = False, test_alert: bool = False) -> dict:
    findings = sorted(set(findings))
    if not set(findings).issubset(CODES):
        raise ValueError("UNKNOWN_FINDING")
    state_path = config["state"]
    with _lock(state_path.with_name(state_path.name + ".lock")):
        state = _read_json(state_path) if state_path.exists() else {"format": "wenyan-ops-health-state-v1"}
        if state.get("format") != "wenyan-ops-health-state-v1":
            raise ValueError("OPS_STATE_INVALID")
        active = state.get("active", [])
        if not isinstance(active, list) or not set(active).issubset(CODES):
            raise ValueError("OPS_STATE_INVALID")
        if test_alert:
            findings, metrics = active, {}
        utc_day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
        if state.get("utc_day") != utc_day:
            state["utc_day"], state["attempts"] = utc_day, 0
        event = "DELIVERY_TEST" if test_alert else "INCIDENT" if findings else "RECOVERY" if state.get("notified_incident") else None
        new_incident = bool(findings and findings != active)
        elapsed = now - float(state.get("last_attempt", 0))
        changed = new_incident or findings != state.get("last_notified", [])
        due = event is not None and (test_alert or changed or elapsed >= config["reminder_seconds"])
        outcome = "recipient_not_configured" if not synthetic and not config["recipient"] else "not_needed"
        if due:
            if not synthetic and not config["recipient"]:
                outcome = "recipient_not_configured"
            elif elapsed < config["cooldown_seconds"]:
                outcome = "cooldown"
            elif int(state.get("attempts", 0)) >= config["daily_limit"]:
                outcome = "daily_limit"
            else:
                state["last_attempt"] = now
                state["attempts"] = int(state.get("attempts", 0)) + 1
                # Persist the attempt before network IO, including failed sends.
                state["active"] = findings
                _write_json(state_path, state)
                try:
                    if synthetic:
                        _write_json(config["synthetic_outbox"], {"synthetic": True, "event": event, "findings": findings})
                    else:
                        send_alert(config, event, [] if test_alert else findings, metrics, now)
                except Exception:
                    outcome = "delivery_failed"
                else:
                    if not test_alert:
                        state["last_notified"] = findings
                        state["notified_incident"] = bool(findings)
                    outcome = "synthetic_recorded" if synthetic else "sent"
        state["active"], state["checked_at"] = findings, now
        _write_json(state_path, state)
    return {"findings": findings, "metrics": metrics, "alert": outcome, "event": event, "synthetic": synthetic}


def configuration() -> dict:
    def integer(name: str, default: int, low: int, high: int) -> int:
        value = int(os.getenv(name, str(default)))
        if not low <= value <= high:
            raise ValueError("CONFIGURATION_RANGE_INVALID")
        return value
    config = {"state": Path(os.getenv("WENYAN_OPS_STATE", "/var/lib/wenyan-ops/health-state.json")),
        "database": Path("/var/lib/wenyan/beta.db"), "disk_path": Path("/var/lib/wenyan"),
        "backup_dir": Path("/var/backups/wenyan"),
        "offsite_receipt": Path(os.getenv("WENYAN_OPS_OFFSITE_RECEIPT", os.getenv("WENYAN_OFFSITE_RECEIPT_PATH", "/var/lib/wenyan-ops/offsite-success.json"))),
        "health_url": "http://127.0.0.1:8000/api/health",
        "backup_hours": integer("WENYAN_OPS_BACKUP_MAX_HOURS", 30, 1, 168),
        "disk_min_mib": integer("WENYAN_OPS_DISK_MIN_MIB", 2048, 128, 1048576),
        "otp_limit": integer("WENYAN_AUTH_EMAIL_DAILY_LIMIT", 80, 1, 10000),
        "otp_warning": integer("WENYAN_OPS_OTP_WARNING_REMAINING", 20, 1, 10000),
        "daily_limit": integer("WENYAN_OPS_ALERT_DAILY_LIMIT", 4, 1, 10),
        "cooldown_seconds": integer("WENYAN_OPS_ALERT_COOLDOWN_SECONDS", 3600, 60, 86400),
        "reminder_seconds": integer("WENYAN_OPS_ALERT_REMINDER_SECONDS", 21600, 3600, 604800),
        "recipient": os.getenv("WENYAN_OPS_ALERT_TO", ""),
        "sender": os.getenv("WENYAN_OPS_ALERT_FROM", os.getenv("WENYAN_AUTH_EMAIL_FROM", "")),
        "api_key": os.getenv("WENYAN_OPS_RESEND_API_KEY", os.getenv("RESEND_API_KEY", ""))}
    if (config["state"] != Path("/var/lib/wenyan-ops/health-state.json") or
            config["offsite_receipt"] != Path("/var/lib/wenyan-ops/offsite-success.json")):
        raise ValueError("FIXED_PRIVATE_OPERATIONS_PATHS_REQUIRED")
    return config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--failure-unit", choices=UNITS)
    parser.add_argument("--test-alert", action="store_true", help="Explicit one-message delivery test; real configured recipient, shared alert budget, no simulated incident")
    parser.add_argument("--synthetic", choices=sorted(CODES | {"RECOVERY"}))
    parser.add_argument("--state", type=Path, help="Synthetic mode only; absolute isolated state path")
    parser.add_argument("--outbox", type=Path, help="Synthetic mode only; private simulated delivery receipt")
    args = parser.parse_args(argv)
    try:
        if args.synthetic:
            if args.failure_unit or args.test_alert or args.state is None or args.outbox is None:
                raise ValueError("SYNTHETIC_PATHS_REQUIRED")
            if args.state == args.outbox:
                raise ValueError("SYNTHETIC_PATHS_MUST_DIFFER")
            if (args.state.parent != args.outbox.parent or
                    not args.state.parent.name.startswith("synthetic-")):
                raise ValueError("ISOLATED_SYNTHETIC_DIRECTORY_REQUIRED")
            config = {"state": args.state, "synthetic_outbox": args.outbox,
                "cooldown_seconds": 3600, "reminder_seconds": 21600, "daily_limit": 4}
            # No live configuration, DB, credentials, provider, health or systemd.
            findings, metrics = ([] if args.synthetic == "RECOVERY" else [args.synthetic]), {}
        else:
            if args.state or args.outbox:
                raise ValueError("SYNTHETIC_ONLY_ARGUMENT")
            if args.test_alert and args.failure_unit:
                raise ValueError("MUTUALLY_EXCLUSIVE_TEST")
            config = configuration()
            findings, metrics = ([], {}) if args.test_alert else inspect(config, time.time())
            if args.failure_unit:
                findings = sorted(set(findings + [dict(zip(UNITS, ("SERVICE_FAILED", "BACKUP_FAILED", "OFFSITE_FAILED")))[args.failure_unit]]))
        report = process(config, findings, metrics, time.time(), synthetic=bool(args.synthetic), test_alert=args.test_alert)
        print(json.dumps(report, sort_keys=True))
        return 1 if findings or report["alert"] in {"delivery_failed", "recipient_not_configured", "daily_limit"} else 0
    except Exception:
        print(json.dumps({"error": "OPS_CHECK_FAILED"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
