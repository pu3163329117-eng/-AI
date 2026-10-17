"""Append-only local editorial opinions, never authenticated teacher approval."""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .session import Base


class AIReasonReviewNote(Base):
    __tablename__ = "ai_reason_review_notes"
    __table_args__ = (UniqueConstraint("suite_digest", "case_id", "revision", name="uq_ai_reason_review_revision"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    suite_digest: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    input_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    case_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    fields: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                             default=lambda: datetime.now(timezone.utc))
