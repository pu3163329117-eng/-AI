"""Additive editorial heads and durable receipts; revisions use the existing table."""
from sqlalchemy import Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .session import Base


class AssessmentQuestionHead(Base):
    __tablename__ = "assessment_question_heads"
    question_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    revision_version: Mapped[str] = mapped_column(String(80), nullable=False)


class AssessmentEditorialReceipt(Base):
    __tablename__ = "assessment_editorial_receipts"
    __table_args__ = (UniqueConstraint("question_id", "idempotency_key", name="uq_assessment_editorial_receipt"),)
    question_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict] = mapped_column(JSON, nullable=False)
