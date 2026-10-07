"""Additive durable learning queues; completed assessment results stay authoritative."""
from datetime import datetime, timezone
import uuid
from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .session import Base


class RecommendationPlan(Base):
    __tablename__ = "recommendation_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    profile_id: Mapped[str] = mapped_column(ForeignKey("learner_profiles.id"), nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class RecommendationHead(Base):
    __tablename__ = "recommendation_heads"
    profile_id: Mapped[str] = mapped_column(ForeignKey("learner_profiles.id"), primary_key=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("recommendation_plans.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)


class RecommendationTask(Base):
    __tablename__ = "recommendation_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    profile_id: Mapped[str] = mapped_column(ForeignKey("learner_profiles.id"), nullable=False, index=True)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id"), nullable=False)
    identity_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("training_sessions.id"), nullable=True, unique=True)


class LearningPathReceipt(Base):
    __tablename__ = "learning_path_receipts"
    __table_args__ = (UniqueConstraint("profile_id", "operation", "idempotency_key", name="uq_learning_path_receipt"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    profile_id: Mapped[str] = mapped_column(ForeignKey("learner_profiles.id"), nullable=False)
    operation: Mapped[str] = mapped_column(String(80), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict] = mapped_column(JSON, nullable=False)
