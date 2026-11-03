"""Account-level product tour and support inbox; no learner-content joins."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .session import Base


class AccountTourProgress(Base):
    __tablename__ = "account_tour_progress"
    user_id: Mapped[str] = mapped_column(ForeignKey("auth_users.id"), primary_key=True)
    version: Mapped[str] = mapped_column(String(40), primary_key=True)
    step: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SupportFeedback(Base):
    __tablename__ = "support_feedback"
    __table_args__ = (UniqueConstraint("user_id", "request_id", name="uq_support_user_request"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("auth_users.id"), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    content_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    reference: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    device: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    page: Mapped[str] = mapped_column(String(32), nullable=False)
    build_version: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="received")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SupportReply(Base):
    """Append-only, learner-visible owner replies. No operator identities/notes."""
    __tablename__ = "support_replies"
    __table_args__ = (UniqueConstraint("feedback_id", "request_id", name="uq_support_reply_request"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    feedback_id: Mapped[str] = mapped_column(ForeignKey("support_feedback.id"), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    content_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
