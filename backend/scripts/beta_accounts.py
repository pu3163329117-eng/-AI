"""Offline invitation and revocation commands. No HTTP admin enrollment endpoint.

Run from repository root: python -m backend.scripts.beta_accounts --help
Invitation plaintext is written once to a NEW operator-selected file, never logs.
Protect that directory with OS ACLs; do not use a web-served or Git tracked path.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from sqlalchemy import delete, select, update

try:
    from backend.db.session import Base, SessionLocal, engine
    from backend.db import models as _existing_models  # noqa: F401
    from backend.auth.models import AuthAttempt, AuthEmailChallenge, AuthInvite, AuthSession, AuthUser, ProfileOwner, utcnow
    from backend.db.migrations import _v5_email_identity
    from backend.auth.service import create_invite
    from backend.auth.settings import load_access_settings
except ModuleNotFoundError:
    raise SystemExit("Run from the repository root with python -m backend.scripts.beta_accounts")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline beta invitation/session administration; no passwords on argv")
    commands = parser.add_subparsers(dest="command", required=True)
    invite = commands.add_parser("invite", help="Create one-use invitation; plaintext goes only to a new secret file")
    invite.add_argument("--role", required=True, choices=["learner", "admin"])
    invite.add_argument("--hours", type=int, default=72)
    invite.add_argument("--email", help="Bind this invitation to exactly one email address")
    invite.add_argument("--output", type=Path, required=True, help="New private file outside the project; never overwritten")
    for command, help_text in [("revoke-invite", "Revoke invitation by its non-secret ID"),
                               ("revoke-session", "Revoke session by its non-secret ID"),
                               ("revoke-user-sessions", "Revoke all sessions of a user ID")]:
        sub = commands.add_parser(command, help=help_text)
        sub.add_argument("--id", required=True)
    commands.add_parser("purge-expired-attempts", help="Delete only expired rate-limit counters")
    args = parser.parse_args(argv)
    settings = load_access_settings()
    if settings.mode != "invite":
        parser.error("Set WENYAN_ACCESS_MODE=invite and WENYAN_AUTH_ORIGINS before administering beta access")
    # Create only auth tables, never seed/alter learner records or legacy data.
    Base.metadata.create_all(engine, tables=[AuthUser.__table__, AuthInvite.__table__, AuthSession.__table__, ProfileOwner.__table__, AuthAttempt.__table__, AuthEmailChallenge.__table__])
    _v5_email_identity(engine)
    with SessionLocal() as db:
        if args.command == "invite":
            if not 1 <= args.hours <= 168:
                parser.error("--hours must be between 1 and 168")
            target = args.output.resolve()
            project = Path(__file__).resolve().parents[2]
            if target.is_relative_to(project):
                parser.error("Invitation secret output must be outside the project and web-served directories")
            # Reserve file before consuming a database row; O_EXCL prevents overwrite.
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            invite_row = None
            try:
                token, invite_row = create_invite(db, role=args.role, expires_hours=args.hours, email=args.email)
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    fd = -1
                    output.write(token + "\n")
                print(f"Created {args.role} invitation ID {invite_row.id}; secret saved to the selected private file.")
                print("Deliver securely. Restrict the file's OS ACL and delete it after delivery. Never commit it.")
            except BaseException:
                if fd != -1:
                    os.close(fd)
                if invite_row is not None:
                    invite_row.revoked_at = utcnow()
                    db.commit()
                raise
        elif args.command == "purge-expired-attempts":
            result = db.execute(delete(AuthAttempt).where(AuthAttempt.expires_at <= utcnow()))
            db.commit()
            print(f"Purged {result.rowcount} expired counters.")
        else:
            if args.command == "revoke-invite":
                statement = update(AuthInvite).where(AuthInvite.id == args.id).values(revoked_at=utcnow())
            elif args.command == "revoke-session":
                statement = update(AuthSession).where(AuthSession.id == args.id).values(revoked_at=utcnow())
            else:
                statement = update(AuthSession).where(AuthSession.user_id == args.id, AuthSession.revoked_at.is_(None)).values(revoked_at=utcnow())
            result = db.execute(statement)
            db.commit()
            print(f"Revoked {result.rowcount} matching record(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
