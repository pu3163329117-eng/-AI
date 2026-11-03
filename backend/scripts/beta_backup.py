"""Private SQLite snapshots. Never overwrite a source, backup, or restore target.

Run from the repository root: python -m backend.scripts.beta_backup --help
The CLI deliberately does not read .env or open the configured running database.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import time
from typing import Any


class BackupError(ValueError):
    """An operator-safe error code, never SQL rows or credentials."""


def checked_path(value: str | Path, *, existing: bool) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise BackupError("ABSOLUTE_CANONICAL_PATH_REQUIRED")
    if os.name == "nt" and (str(path).startswith(("\\\\.\\", "\\\\?\\")) or any(":" in part for part in path.parts[1:])):
        raise BackupError("DEVICE_OR_ALTERNATE_STREAM_NOT_ALLOWED")
    # Check lexical ancestors before resolve, including Windows junctions.
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise BackupError("LINK_OR_JUNCTION_NOT_ALLOWED")
        if item.exists():
            info = item.lstat()
            if getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                raise BackupError("REPARSE_POINT_NOT_ALLOWED")
    if not path.parent.is_dir() or path == path.parent:
        raise BackupError("EXISTING_PARENT_DIRECTORY_REQUIRED")
    if existing:
        if not path.is_file() or path.stat().st_nlink > 1:
            raise BackupError("REGULAR_SINGLE_LINK_FILE_REQUIRED")
    elif path.exists():
        raise BackupError("DESTINATION_ALREADY_EXISTS")
    return path.resolve(strict=existing)


def _reserve(path: Path) -> None:
    checked_path(path, existing=False)
    if any(Path(str(path) + suffix).exists() or Path(str(path) + suffix).is_symlink()
           for suffix in ("-wal", "-shm", "-journal")):
        raise BackupError("DESTINATION_SIDECAR_ALREADY_EXISTS")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as exc:
        raise BackupError("CANNOT_CREATE_PRIVATE_DESTINATION") from exc
    os.close(fd)


def _readonly(path: Path) -> sqlite3.Connection:
    checked_path(path, existing=True)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            checked_path(sidecar, existing=True)
    conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    conn.execute("PRAGMA trusted_schema = OFF")
    return conn


def _sha256(path: Path) -> str:
    checked_path(path, existing=True)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _metadata(conn: sqlite3.Connection) -> dict[str, Any]:
    if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise BackupError("SQLITE_INTEGRITY_FAILED")
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise BackupError("SQLITE_FOREIGN_KEY_CHECK_FAILED")
    schema = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").fetchall()
    counts = {
        row[1]: conn.execute(f"SELECT COUNT(*) FROM {_quote(row[1])}").fetchone()[0]
        for row in schema if row[0] == "table" and not row[1].startswith("sqlite_")
    }
    return {
        "integrity": "ok",
        "foreign_keys": "ok",
        "schema_sha256": hashlib.sha256(json.dumps(schema, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "table_counts": counts,
        "user_version": conn.execute("PRAGMA user_version").fetchone()[0],
    }


def _snapshot(source: Path, destination: Path) -> None:
    # backup() includes committed WAL pages without a dangerous raw file copy.
    deadline = time.monotonic() + 60

    def progress(_status: int, _remaining: int, _total: int) -> None:
        if time.monotonic() > deadline:
            raise BackupError("SNAPSHOT_TIMEOUT")

    checked_path(destination, existing=True)
    with closing(_readonly(source)) as read_conn, closing(sqlite3.connect(destination)) as write_conn:
        write_conn.execute("PRAGMA trusted_schema = OFF")
        read_conn.backup(write_conn, pages=128, progress=progress, sleep=0.05)
        write_conn.execute("PRAGMA journal_mode = DELETE")
        write_conn.commit()


def _write_manifest(path: Path, payload: dict[str, Any]) -> None:
    checked_path(path, existing=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _manifest_path(database: Path) -> Path:
    return Path(str(database) + ".manifest.json")


def _discard_created(paths: list[Path]) -> None:
    # These are exclusively reserved files from this call, never user files.
    for path in reversed(paths):
        try:
            checked_path(path, existing=True).unlink()
        except (OSError, BackupError):
            pass


def backup(database: str | Path, destination: str | Path) -> dict[str, Any]:
    source = checked_path(database, existing=True)
    target = checked_path(destination, existing=False)
    manifest = checked_path(_manifest_path(target), existing=False)
    if source == target or source == manifest:
        raise BackupError("SOURCE_DESTINATION_MUST_DIFFER")
    created: list[Path] = []
    try:
        for path in (target, manifest):
            _reserve(path)
            created.append(path)
        _snapshot(source, target)
        with closing(_readonly(target)) as conn:
            metadata = _metadata(conn)
        report = {
            "format": "wenyan-sqlite-backup-v1",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "database_sha256": _sha256(target),
            "database_size_bytes": target.stat().st_size,
            **metadata,
        }
        _write_manifest(manifest, report)
        verify(target)
        return report
    except Exception:
        _discard_created(created)
        raise


def verify(backup_path: str | Path) -> dict[str, Any]:
    source = checked_path(backup_path, existing=True)
    manifest = checked_path(_manifest_path(source), existing=True)
    if manifest.stat().st_size > 1_048_576:
        raise BackupError("MANIFEST_TOO_LARGE")
    try:
        report = json.loads(manifest.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise BackupError("MANIFEST_INVALID") from exc
    if not isinstance(report, dict) or report.get("format") != "wenyan-sqlite-backup-v1":
        raise BackupError("MANIFEST_FORMAT_UNSUPPORTED")
    expected = report.get("database_sha256")
    if not isinstance(expected, str) or not hmac.compare_digest(expected, _sha256(source)):
        raise BackupError("BACKUP_HASH_MISMATCH")
    if report.get("database_size_bytes") != source.stat().st_size:
        raise BackupError("BACKUP_SIZE_MISMATCH")
    with closing(_readonly(source)) as conn:
        metadata = _metadata(conn)
    if any(report.get(key) != value for key, value in metadata.items()):
        raise BackupError("BACKUP_METADATA_MISMATCH")
    return report


def _revoke_restored_auth(conn: sqlite3.Connection) -> dict[str, Any]:
    names = {row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    if any(name.startswith("auth_") for name in names) and not {"auth_users", "auth_sessions", "auth_invites"}.issubset(names):
        raise BackupError("AUTH_CORE_TABLES_MISSING")
    if any(name.startswith("auth_") and name not in {"auth_users", "auth_sessions", "auth_invites", "auth_attempts", "auth_email_challenges"} for name in names):
        raise BackupError("AUTH_TABLE_SCHEMA_UNSUPPORTED")
    sessions = 0
    invitations = 0
    email_challenges = 0
    if "auth_sessions" in names:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(auth_sessions)")}
        if "revoked_at" not in columns:
            raise BackupError("AUTH_SESSION_SCHEMA_UNSUPPORTED")
        sessions = conn.execute("SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NULL").fetchone()[0]
        conn.execute("UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL", (datetime.now(timezone.utc).isoformat(),))
    # Revoke every invitation, used or unused. This intentionally avoids reviving
    # any code consumed after the snapshot was taken; users themselves remain.
    if "auth_invites" in names:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(auth_invites)")}
        if "revoked_at" not in columns:
            raise BackupError("AUTH_INVITE_SCHEMA_UNSUPPORTED")
        invitations = conn.execute("SELECT COUNT(*) FROM auth_invites WHERE revoked_at IS NULL").fetchone()[0]
        conn.execute("UPDATE auth_invites SET revoked_at = ? WHERE revoked_at IS NULL", (datetime.now(timezone.utc).isoformat(),))
    elif any(name.startswith("auth_") and "invit" in name for name in names):
        raise BackupError("AUTH_INVITE_SCHEMA_UNSUPPORTED")
    if "auth_email_challenges" in names:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(auth_email_challenges)")}
        if not {"revoked_at", "deliverable"}.issubset(columns):
            raise BackupError("AUTH_EMAIL_CHALLENGE_SCHEMA_UNSUPPORTED")
        email_challenges = conn.execute("SELECT COUNT(*) FROM auth_email_challenges WHERE revoked_at IS NULL").fetchone()[0]
        conn.execute("UPDATE auth_email_challenges SET revoked_at = ? WHERE revoked_at IS NULL", (datetime.now(timezone.utc).isoformat(),))
        # Restore must never revive an old or pending email code for delivery.
        conn.execute("UPDATE auth_email_challenges SET deliverable = 0")
    return {"revoked_sessions": sessions, "revoked_invitations": invitations, "revoked_email_challenges": email_challenges}


def restore(backup_path: str | Path, destination: str | Path, *, offline_confirmed: bool = False) -> dict[str, Any]:
    if not offline_confirmed:
        raise BackupError("OFFLINE_CONFIRMATION_REQUIRED")
    source = checked_path(backup_path, existing=True)
    report = verify(source)
    target = checked_path(destination, existing=False)
    receipt = checked_path(_manifest_path(target), existing=False)
    if target in (source, _manifest_path(source)):
        raise BackupError("SOURCE_DESTINATION_MUST_DIFFER")
    created: list[Path] = []
    try:
        for path in (target, receipt):
            _reserve(path)
            created.append(path)
        _snapshot(source, target)
        # Detect a concurrently replaced backup before accepting its copy.
        if not hmac.compare_digest(report["database_sha256"], _sha256(target)):
            raise BackupError("RESTORE_SNAPSHOT_HASH_MISMATCH")
        with closing(sqlite3.connect(target)) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA trusted_schema = OFF")
            with conn:
                revocations = _revoke_restored_auth(conn)
            metadata = _metadata(conn)
        result = {
            "format": "wenyan-sqlite-backup-v1",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "restored_from_sha256": report["database_sha256"],
            "database_sha256": _sha256(target),
            "database_size_bytes": target.stat().st_size,
            "auth_revocations": revocations,
            **metadata,
        }
        _write_manifest(receipt, result)
        verify(target)
        return result
    except Exception:
        _discard_created(created)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private SQLite backup, verify, and offline restore. Never overwrites existing files.")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup")
    create.add_argument("--database", required=True, help="Absolute existing SQLite database path; no .env discovery")
    create.add_argument("--destination", required=True, help="Absolute new file in a private non-served directory")
    check = commands.add_parser("verify")
    check.add_argument("--backup", required=True)
    recover = commands.add_parser("restore")
    recover.add_argument("--backup", required=True)
    recover.add_argument("--destination", required=True)
    recover.add_argument("--offline-confirmed", action="store_true", help="Operator has stopped every app/worker that can use the restore target")
    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            result = backup(args.database, args.destination)
        elif args.command == "verify":
            result = verify(args.backup)
        else:
            result = restore(args.backup, args.destination, offline_confirmed=args.offline_confirmed)
        print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
        return 0
    except (BackupError, sqlite3.Error, OSError) as exc:
        # sqlite/OSError strings may contain SQL, paths, or application data.
        code = str(exc) if isinstance(exc, BackupError) else "DATABASE_OR_FILESYSTEM_OPERATION_FAILED"
        print(json.dumps({"status": "error", "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
