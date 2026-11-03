"""Private host-only support inbox. Never exposes an admin HTTP endpoint.

Examples (operator-owned private paths, never place these in the checkout):
  python -m backend.scripts.beta_support --db /var/lib/wenyan/beta.db list
  python -m backend.scripts.beta_support --db /var/lib/wenyan/beta.db show --id UUID
  python -m backend.scripts.beta_support --db /var/lib/wenyan/beta.db export --id UUID --include-content --output /private/new-case.json
  python -m backend.scripts.beta_support --db /var/lib/wenyan/beta.db resolve --id UUID --status in_progress --expected-updated-at UTC_TIME_FROM_SHOW
  python -m backend.scripts.beta_support --db /var/lib/wenyan/beta.db reply --id UUID --request-id UUID --message-file /private/reply.txt --expected-updated-at UTC_TIME_FROM_SHOW --status in_progress

List/show print receipt metadata only. Export deliberately requires an explicit
content flag and a NEW 0600 file under a private directory on the Linux host.
Resolve updates workflow state only, NEVER removes an account or learning data.
Replies are learner-visible, not private notes. No mail or telemetry is sent.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[2]
STATES = ("received", "in_progress", "resolved", "withdrawn")
KINDS = ("feedback", "privacy", "deletion")
CATEGORIES = ("bug", "suggestion", "other")
SUMMARY = "id, reference, kind, category, page, build_version, status, created_at, updated_at"
# Keep the same conservative obvious-credential checks as public submissions.
# These are not a guarantee of complete secret or personal-data detection.
SENSITIVE = re.compile(
    r"(?:\b(?:sk|re)_[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|"
    r"\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:cookie|authorization|api[_ -]?key)\s*[:=]\s*\S+|"
    r"(?:验证码|OTP|verification\s*code)\s*(?:是|为|[:：=])?\s*[0-9]{6}\b|"
    r"(?:邀请码|invite[_ -]?code)\s*(?:是|为|[:：=])?\s*[A-Za-z0-9_-]{16,}|"
    r"\bwenyan_beta_session\s*=\s*\S+|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,128}(?![A-Za-z0-9_-])|"
    r"(?<![0-9])[0-9]{6}(?![0-9]))", re.IGNORECASE,
)


class SupportError(ValueError):
    """Constant operator-safe failures; no submitted content in diagnostics."""


class _PrivateArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs["allow_abbrev"] = False
        super().__init__(*args, **kwargs)

    def error(self, message):
        # argparse normally echoes unknown values, potentially a mistaken
        # plaintext reply or credential. Only print a constant failure code.
        self.exit(2, "SUPPORT_CLI_ARGUMENTS_INVALID\n")


def regular_path(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise SupportError("ABSOLUTE_PATH_REQUIRED")
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise SupportError("LINK_PATH_FORBIDDEN")
    return path


def connect(value: str | Path, *, write=False) -> sqlite3.Connection:
    path = regular_path(value)
    if not path.is_file():
        raise SupportError("DATABASE_FILE_REQUIRED")
    conn = sqlite3.connect(path.as_uri() + ("?mode=rw" if write else "?mode=ro"), uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA trusted_schema=OFF")
    if not write:
        conn.execute("PRAGMA query_only=ON")
    return conn


def identifier(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError:
        raise SupportError("SUPPORT_ID_INVALID") from None


def listing(db: str | Path, *, limit=20, status=None, kind=None, category=None) -> dict:
    if (type(limit) is not int or not 1 <= limit <= 100 or (status and status not in STATES)
            or (kind and kind not in KINDS) or (category and category not in CATEGORIES)):
        raise SupportError("LIST_FILTER_INVALID")
    with connect(db) as conn:
        filters = [("status", status), ("kind", kind), ("category", category)]
        active = [(name, value) for name, value in filters if value]
        where = " WHERE " + " AND ".join(name + " = ?" for name, _ in active) if active else ""
        args = [value for _, value in active]
        rows = conn.execute(f"SELECT {SUMMARY} FROM support_feedback{where} ORDER BY created_at DESC LIMIT ?", [*args, limit])
        return {"items": [dict(row) for row in rows], "content_included": False}


def show(db: str | Path, record_id: str) -> dict:
    with connect(db) as conn:
        row = conn.execute(f"SELECT {SUMMARY} FROM support_feedback WHERE id = ?", (identifier(record_id),)).fetchone()
        if row is None:
            raise SupportError("SUPPORT_NOT_FOUND")
        return dict(row)


def export(db: str | Path, record_id: str, output: str | Path, *, include_content=False) -> dict:
    if include_content is not True:
        raise SupportError("EXPLICIT_CONTENT_FLAG_REQUIRED")
    path = regular_path(output)
    if path.exists() or not path.parent.is_dir():
        raise SupportError("NEW_FILE_PRIVATE_PARENT_REQUIRED")
    if path.resolve().is_relative_to(ROOT):
        raise SupportError("EXPORT_OUTSIDE_CHECKOUT_REQUIRED")
    # Windows chmod does not establish a private NTFS DACL. Fail closed instead
    # of calling a file 'private' when its inherited permissions are unknown.
    if os.name != "posix":
        raise SupportError("PRIVATE_EXPORT_REQUIRES_LINUX_HOST")
    if path.parent.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SupportError("PRIVATE_PARENT_PERMISSIONS_REQUIRED")
    with connect(db) as conn:
        row = conn.execute(f"SELECT {SUMMARY}, message, device FROM support_feedback WHERE id = ?", (identifier(record_id),)).fetchone()
        if row is None:
            raise SupportError("SUPPORT_NOT_FOUND")
        content = dict(row)
        content["replies"] = [dict(reply) for reply in conn.execute(
            "SELECT id, message, created_at FROM support_replies WHERE feedback_id = ? ORDER BY created_at, id", (row["id"],))]
        body = (json.dumps(content, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise
    return {"exported": True, "id": str(UUID(record_id)), "content_included": True}


def _timestamp(value) -> datetime:
    if not isinstance(value, str):
        raise SupportError("SUPPORT_EXPECTED_VERSION_REQUIRED")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        # Existing SQLite metadata stores UTC without a suffix; show's old
        # timestamps remain acceptable as CAS tokens for backward compatibility.
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except ValueError:
        raise SupportError("SUPPORT_EXPECTED_VERSION_INVALID") from None


def _version(row, expected_updated_at):
    if _timestamp(row["updated_at"]) != _timestamp(expected_updated_at):
        raise SupportError("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED")


def _next_updated_at(previous) -> str:
    now = datetime.now(timezone.utc)
    return max(now, _timestamp(previous) + timedelta(microseconds=1)).isoformat()


def resolve(db: str | Path, record_id: str, status: str, *, expected_updated_at=None) -> dict:
    if status not in STATES:
        raise SupportError("SUPPORT_STATUS_INVALID")
    with connect(db, write=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(f"SELECT {SUMMARY} FROM support_feedback WHERE id = ?", (identifier(record_id),)).fetchone()
        if row is None:
            raise SupportError("SUPPORT_NOT_FOUND")
        _version(row, expected_updated_at)
        if row["status"] != status:
            changed = conn.execute("UPDATE support_feedback SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
                (status, _next_updated_at(row["updated_at"]), row["id"], row["updated_at"]))
            if changed.rowcount != 1:
                raise SupportError("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED")
        conn.commit()
    return show(db, record_id)


def _reply_text(message: str) -> str:
    if not isinstance(message, str):
        raise SupportError("SUPPORT_REPLY_INVALID")
    message = message.strip()
    if not 10 <= len(message) <= 2000:
        raise SupportError("SUPPORT_REPLY_LENGTH_INVALID")
    try:
        message.encode("utf-8")
    except UnicodeEncodeError:
        raise SupportError("SUPPORT_REPLY_INVALID") from None
    if SENSITIVE.search(message):
        raise SupportError("SUPPORT_REPLY_SENSITIVE_CONTENT")
    if any(ord(char) < 32 and char not in "\n\t" for char in message):
        raise SupportError("SUPPORT_REPLY_INVALID")
    return message


def _private_message_file(value: str | Path) -> str:
    path = regular_path(value)
    if os.name != "posix":
        raise SupportError("PRIVATE_REPLY_REQUIRES_LINUX_HOST")
    if path.resolve().is_relative_to(ROOT) or not path.parent.is_dir():
        raise SupportError("PRIVATE_REPLY_OUTSIDE_CHECKOUT_REQUIRED")
    if path.parent.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SupportError("PRIVATE_PARENT_PERMISSIONS_REQUIRED")
    if not path.is_file() or path.stat().st_nlink != 1:
        raise SupportError("PRIVATE_REPLY_FILE_REQUIRED")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_mode & (stat.S_IRWXG | stat.S_IRWXO) or info.st_size > 10000):
            raise SupportError("PRIVATE_REPLY_FILE_REQUIRED")
        data = handle.read(10001)
    try:
        return _reply_text(data.decode("utf-8"))
    except UnicodeDecodeError:
        raise SupportError("SUPPORT_REPLY_INVALID") from None


def _publish_reply(db: str | Path, record_id: str, *, message: str, request_id: str,
        expected_updated_at, status=None) -> dict:
    """Internal transaction helper; CLI only reaches this via a private file."""
    message, case_id, request_id = _reply_text(message), identifier(record_id), identifier(request_id)
    if status is not None and status not in STATES:
        raise SupportError("SUPPORT_STATUS_INVALID")
    digest = hashlib.sha256(json.dumps({"message": message, "status": status}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with connect(db, write=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(f"SELECT {SUMMARY} FROM support_feedback WHERE id = ?", (case_id,)).fetchone()
        if row is None:
            raise SupportError("SUPPORT_NOT_FOUND")
        previous = conn.execute("SELECT id, content_digest, created_at FROM support_replies WHERE feedback_id = ? AND request_id = ?", (case_id, request_id)).fetchone()
        if previous:
            if not secrets.compare_digest(previous["content_digest"], digest):
                raise SupportError("SUPPORT_REPLY_IDEMPOTENCY_CONFLICT")
            return {"published": True, "feedback_id": case_id, "reply_id": previous["id"],
                "created_at": previous["created_at"], "content_included": False}
        _version(row, expected_updated_at)
        if conn.execute("SELECT COUNT(*) FROM support_replies WHERE feedback_id = ?", (case_id,)).fetchone()[0] >= 20:
            raise SupportError("SUPPORT_REPLY_CASE_LIMIT")
        reply_id, now = str(uuid4()), _next_updated_at(row["updated_at"])
        conn.execute("INSERT INTO support_replies (id, feedback_id, request_id, content_digest, message, created_at) VALUES (?,?,?,?,?,?)",
            (reply_id, case_id, request_id, digest, message, now))
        changed = conn.execute("UPDATE support_feedback SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
            (status or row["status"], now, case_id, row["updated_at"]))
        if changed.rowcount != 1:
            raise SupportError("SUPPORT_CASE_CHANGED_REFRESH_REQUIRED")
        conn.commit()
        return {"published": True, "feedback_id": case_id, "reply_id": reply_id, "created_at": now, "content_included": False}


def reply(db: str | Path, record_id: str, *, message_file, request_id, expected_updated_at, status=None) -> dict:
    return _publish_reply(db, record_id, message=_private_message_file(message_file), request_id=request_id,
        expected_updated_at=expected_updated_at, status=status)


def main(argv=None) -> int:
    parser = _PrivateArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    ls = commands.add_parser("list")
    ls.add_argument("--limit", type=int, default=20)
    ls.add_argument("--status", choices=STATES)
    ls.add_argument("--kind", choices=KINDS)
    ls.add_argument("--category", choices=CATEGORIES)
    for name in ("show", "export", "resolve", "reply"):
        command = commands.add_parser(name)
        command.add_argument("--id", required=True)
        if name == "export":
            command.add_argument("--output", required=True)
            command.add_argument("--include-content", action="store_true")
        if name == "resolve":
            command.add_argument("--status", choices=STATES, required=True)
            command.add_argument("--expected-updated-at", required=True)
        if name == "reply":
            command.add_argument("--message-file", required=True)
            command.add_argument("--request-id", required=True)
            command.add_argument("--expected-updated-at", required=True)
            command.add_argument("--status", choices=STATES)
    args = parser.parse_args(argv)
    try:
        if args.command == "list":
            result = listing(args.db, limit=args.limit, status=args.status, kind=args.kind, category=args.category)
        elif args.command == "show":
            result = show(args.db, args.id)
        elif args.command == "export":
            result = export(args.db, args.id, args.output, include_content=args.include_content)
        elif args.command == "resolve":
            result = resolve(args.db, args.id, args.status, expected_updated_at=args.expected_updated_at)
        else:
            result = reply(args.db, args.id, message_file=args.message_file, request_id=args.request_id,
                expected_updated_at=args.expected_updated_at, status=args.status)
    except (SupportError, sqlite3.Error, OSError):
        print(json.dumps({"error": "SUPPORT_OPERATION_FAILED"}))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
