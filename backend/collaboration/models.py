from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CollaborationBase(DeclarativeBase):
    pass


class CollaborationTask(CollaborationBase):
    __tablename__ = "collaboration_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(80), index=True)
    title: Mapped[str] = mapped_column(String(200))
    objective: Mapped[str] = mapped_column(Text)
    acceptance_criteria: Mapped[list[str]] = mapped_column(JSON)
    forbidden_actions: Mapped[list[str]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default="OPEN", index=True)
    harness_session_id: Mapped[str] = mapped_column(String(80), unique=True)
    current_manifest_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ContextManifest(CollaborationBase):
    __tablename__ = "collaboration_context_manifests"
    __table_args__ = (
        UniqueConstraint("task_id", "version", name="uq_manifest_task_version"),
        UniqueConstraint("task_id", "idempotency_key", name="uq_manifest_task_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("collaboration_tasks.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    authorization_scope: Mapped[dict[str, Any]] = mapped_column(JSON)
    content_sha256: Mapped[str] = mapped_column(String(64))
    request_sha256: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    byte_count: Mapped[int] = mapped_column(Integer)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CollaborationMessage(CollaborationBase):
    __tablename__ = "collaboration_messages"
    __table_args__ = (UniqueConstraint("task_id", "idempotency_key", name="uq_message_task_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("collaboration_tasks.id"), index=True)
    # Deliberately not a database FK: a user message and its run are created in
    # one transaction and reference each other.  The service owns that pair and
    # avoids a circular SQLite insert dependency.
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    content_sha256: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    sequence: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CollaborationRun(CollaborationBase):
    __tablename__ = "collaboration_runs"
    __table_args__ = (UniqueConstraint("task_id", "idempotency_key", name="uq_run_task_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("collaboration_tasks.id"), index=True)
    manifest_id: Mapped[str] = mapped_column(ForeignKey("collaboration_context_manifests.id"))
    parent_run_id: Mapped[str | None] = mapped_column(ForeignKey("collaboration_runs.id"), nullable=True)
    request_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(120))
    request_sha256: Mapped[str] = mapped_column(String(64))
    limits: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default="QUEUED", index=True)
    runtime: Mapped[str] = mapped_column(String(32))
    harness_session_id: Mapped[str] = mapped_column(String(80), index=True)
    harness_message_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    outcome_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    cancellation_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CollaborationArtifact(CollaborationBase):
    __tablename__ = "collaboration_artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("collaboration_tasks.id"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("collaboration_runs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    review_status: Mapped[str] = mapped_column(String(32), default="CANDIDATE")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    content_sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(CollaborationBase):
    __tablename__ = "collaboration_audit_events"
    __table_args__ = (UniqueConstraint("run_id", "run_sequence", name="uq_audit_run_sequence"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    run_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor: Mapped[str] = mapped_column(String(40))
    event_type: Mapped[str] = mapped_column(String(80))
    details: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
