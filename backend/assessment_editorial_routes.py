"""Local-only item review workflow. No authentication has been implemented."""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

try:
    from backend.db.session import get_db
    from backend.db import assessment_editorial as store
    from backend.domain import assessment_bank as bank
except ModuleNotFoundError:
    from db.session import get_db
    from db import assessment_editorial as store
    from domain import assessment_bank as bank

router = APIRouter(prefix="/api/v1/admin/assessment/questions")
Db = Annotated[Session, Depends(get_db)]
Key = Annotated[str | None, Header(alias="Idempotency-Key")]
Dimension = Literal["vocabulary", "syntax", "context", "chapter"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Option(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=2000)

    @field_validator("id", "text")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("nonblank required")
        return value.strip()


class QuestionFields(StrictModel):
    dimension: Dimension
    difficulty: Literal["L1", "L2", "L3"]
    type: Literal["choice"]
    stem: str = Field(min_length=1, max_length=4000)
    source: str = Field(min_length=1, max_length=200)
    source_url: str = Field(min_length=1, max_length=2000)
    passage: str = Field(min_length=1, max_length=20000)
    text_version: str = Field(min_length=1, max_length=200)
    material_extent: Literal["FULL", "CHAPTER", "EXCERPT"]
    passage_extent: Literal["FULL", "CHAPTER", "EXCERPT"]
    paragraph_index: int | None = Field(strict=True, ge=0)
    start: int | None = Field(strict=True, ge=0)
    end: int | None = Field(strict=True, ge=0)
    full_text_start: int = Field(strict=True, ge=0)
    full_text_end: int = Field(strict=True, ge=0)
    options: list[Option] = Field(min_length=2, max_length=8)
    answer_id: str = Field(min_length=1, max_length=120)
    explanation: str = Field(min_length=1, max_length=8000)
    tags: list[str] = Field(max_length=30)

    @field_validator("stem", "explanation", "answer_id")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("nonblank required")
        return value.strip()

    @field_validator("tags")
    @classmethod
    def valid_tags(cls, values):
        if any(not v.strip() or len(v) > 120 for v in values) or len(set(values)) != len(values):
            raise ValueError("unique nonblank tags required")
        return values


class Attribution(StrictModel):
    expected_version: int = Field(strict=True, ge=0)
    actor: str = Field(min_length=1, max_length=80)
    note: str = Field(min_length=1, max_length=2000)

    @field_validator("actor", "note")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("manual attribution and basis required")
        return value.strip()


class EditRequest(Attribution):
    question: QuestionFields


class ReviewRequest(Attribution):
    decision: Literal["APPROVE", "REJECT"]


def key_required(key):
    if key is None or not key.strip() or len(key) > 255:
        store.fail("IDEMPOTENCY_KEY_REQUIRED", 400)
    return key


@router.get("")
def list_questions(db: Db, dimension: Dimension | None = None,
                   review_status: Literal["DRAFT", "APPROVED", "REJECTED"] | None = None,
                   limit: int = Query(default=20, ge=1, le=100), offset: int = Query(default=0, ge=0)):
    return store.listing(db, bank.QUESTION_BANK, dimension, review_status, limit, offset)


@router.get("/{question_id}")
def get_question(question_id: str, db: Db):
    return store.detail(db, question_id, bank.QUESTION_BANK)


@router.patch("/{question_id}")
def edit_question(question_id: str, request: EditRequest, db: Db, idempotency_key: Key = None):
    return store.revise(db, question_id, bank.QUESTION_BANK, request, "EDIT", key_required(idempotency_key))


@router.post("/{question_id}/review")
def review_question(question_id: str, request: ReviewRequest, db: Db, idempotency_key: Key = None):
    return store.revise(db, question_id, bank.QUESTION_BANK, request, "REVIEW", key_required(idempotency_key))
