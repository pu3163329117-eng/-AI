"""Immutable first learning-stage observations, not formal capability scores."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import DateTime, ForeignKey, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .session import Base


class StageObservation(Base):
    __tablename__ = "stage_observations"
    __table_args__ = (UniqueConstraint("session_id", "stage", name="uq_stage_observation"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("training_sessions.id"), nullable=False, index=True)
    profile_id: Mapped[str | None] = mapped_column(ForeignKey("learner_profiles.id"), nullable=True, index=True)
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    source_event_id: Mapped[str] = mapped_column(ForeignKey("training_events.id"), nullable=False, unique=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
