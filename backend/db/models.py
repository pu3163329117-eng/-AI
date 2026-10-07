from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .session import Base


class LearnerProfile(Base):
    __tablename__ = "learner_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    display_name: Mapped[str] = mapped_column(String(20), nullable=False)
    school_stage: Mapped[str] = mapped_column(String(20), nullable=False)
    total_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_levels: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class Lesson(Base):
    __tablename__ = "lessons"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    school_stage: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    level_order: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    difficulty: Mapped[str] = mapped_column(String(30), nullable=False)
    estimated_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    summary: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PUBLISHED", index=True)
    # Editorial fields deliberately live on the lesson, while the learner only receives
    # a frozen copy of the content when a training session is created.
    textbook_tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    theme: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    reasoning_level: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    accumulation_points: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    reasoning_points: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class LessonContent(Base):
    __tablename__ = "lesson_contents"
    __table_args__ = (UniqueConstraint("lesson_id", "stage", name="uq_lesson_content_stage"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class LessonReview(Base):
    """Append-only attestation; editing a lesson never overwrites its history."""

    __tablename__ = "lesson_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id", ondelete="CASCADE"), nullable=False, index=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    reviewer: Mapped[str] = mapped_column(String(80), nullable=False)
    note: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(), nullable=False)


class ReadingDocument(Base):
    """Immutable source text versions; a new corpus never reuses old offsets."""

    __tablename__ = "reading_documents"
    __table_args__ = (UniqueConstraint("source", "corpus_hash", name="uq_reading_document_version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    corpus_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    context: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class KnowledgeOccurrence(Base):
    """POSITION rows index characters; only ANNOTATION rows assert a meaning."""

    __tablename__ = "knowledge_occurrences"
    __table_args__ = (UniqueConstraint("document_id", "occurrence_key", name="uq_knowledge_occurrence_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("reading_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    occurrence_key: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    paragraph_index: Mapped[int] = mapped_column(Integer, nullable=False)
    start: Mapped[int] = mapped_column(Integer, nullable=False)
    end: Mapped[int] = mapped_column(Integer, nullable=False)
    surface: Mapped[str] = mapped_column(String(100), nullable=False)
    sentence: Mapped[str] = mapped_column(String(20000), nullable=False)
    sense_key: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    meaning: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    part_of_speech: Mapped[str | None] = mapped_column(String(80), nullable=True)
    variability: Mapped[str | None] = mapped_column(String(20), nullable=True)
    reasoning: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="DRAFT")


class AnnotationHead(Base):
    """Mutable version pointer; seeded occurrences and revisions stay untouched."""
    __tablename__ = "annotation_heads"
    annotation_id: Mapped[str] = mapped_column(ForeignKey("knowledge_occurrences.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)


class AnnotationRevision(Base):
    __tablename__ = "annotation_revisions"
    __table_args__ = (UniqueConstraint("annotation_id", "version", name="uq_annotation_revision"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    annotation_id: Mapped[str] = mapped_column(ForeignKey("knowledge_occurrences.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    note: Mapped[str] = mapped_column(String(2000), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class TrainingSession(Base):
    __tablename__ = "training_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    profile_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("learner_profiles.id", ondelete="SET NULL"), nullable=True, index=True)
    lesson_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("lessons.id", ondelete="SET NULL"), nullable=True, index=True)
    state_version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class TrainingEvent(Base):
    __tablename__ = "training_events"
    __table_args__ = (UniqueConstraint("session_id", "sequence_no", name="uq_training_event_sequence"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("training_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    sequence_no: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class CommandReceipt(Base):
    __tablename__ = "command_receipts"
    __table_args__ = (UniqueConstraint("session_id", "idempotency_key", name="uq_command_idempotency"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("training_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
