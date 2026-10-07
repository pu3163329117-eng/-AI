"""Local trial assessment endpoints. Profile IDs are not authentication."""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    from backend.db.session import get_db
    from backend.db import assessment as store
    from backend.db.assessment_models import LessonAbility
    from backend.db.models import Lesson
    from backend import config
    from backend.domain import assessment as domain
    from backend.domain import assessment_bank as bank
except ModuleNotFoundError:
    from db.session import get_db
    from db import assessment as store
    from db.assessment_models import LessonAbility
    from db.models import Lesson
    import config
    from domain import assessment as domain
    from domain import assessment_bank as bank

router = APIRouter(prefix="/api/v1")
Db = Annotated[Session, Depends(get_db)]


class CreateAssessmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str = Field(min_length=1, max_length=36)
    mode: Literal["PILOT", "FORMAL"] = "PILOT"
    self_level: Literal["L1", "L2", "L3"] | None = None
    self_answers: dict[str, str] = Field(default_factory=dict)

    @field_validator("self_answers")
    @classmethod
    def valid_self_answers(cls, values):
        allowed = {"level": {"L1", "L2", "L3", "UNSURE"},
            "goal": {"FOUNDATION", "READING", "EXAM", "INTEREST"},
            "word_strategy": {"CONTEXT", "NOTES", "GUESS", "UNSURE"},
            "reading_experience": {"NEW", "GUIDED", "INDEPENDENT", "UNSURE"}}
        if any(key not in allowed or value not in allowed[key] for key, value in values.items()):
            raise ValueError("invalid unscored self assessment")
        return values


class AssessmentPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: str | None = Field(default=None, min_length=1, max_length=120)
    option_id: str | None = Field(default=None, min_length=1, max_length=120)
    current_index: int | None = Field(default=None, strict=True, ge=0, le=23)


class AssessmentCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["SAVE_ANSWER", "SKIP_QUESTION", "COMPLETE_ASSESSMENT", "ABANDON_ASSESSMENT"]
    expected_state_version: int = Field(strict=True, ge=0)
    payload: AssessmentPayload = Field(default_factory=AssessmentPayload)

    @model_validator(mode="after")
    def validate_command(self):
        fields = self.payload.model_fields_set
        if self.type == "SAVE_ANSWER" and (self.payload.question_id is None or self.payload.option_id is None):
            raise ValueError("saving requires question and option")
        if self.type == "SKIP_QUESTION" and (self.payload.question_id is None or "option_id" in fields):
            raise ValueError("skipping requires question only")
        if self.type in ("COMPLETE_ASSESSMENT", "ABANDON_ASSESSMENT") and fields:
            raise ValueError("completion and abandonment accept empty payload only")
        return self


@router.get("/assessments/availability")
def availability(db: Db):
    questions = store.bank_questions(db, bank.QUESTION_BANK)
    pilot = domain.candidate_questions(questions)
    approved = domain.candidate_questions(questions, True)
    formal_ready = config.ASSESSMENT_ENABLED and domain.can_assemble(approved, True)
    pilot_ready = config.ASSESSMENT_ENABLED and domain.can_assemble(pilot)
    return {"pilot_available": pilot_ready, "formal_available": formal_ready,
        "pilot_question_count": len(pilot), "approved_question_count": len(approved), "questions_per_session": 24,
        "bank_version": bank.BANK_VERSION, "reason": "测评新建入口暂时关闭；已有测评仍可恢复。" if not config.ASSESSMENT_ENABLED else
        "正式题库分层审核条件已满足，评分仍是试行规则。" if formal_ready else
        "题库仍待真实人工审核；仅开放流程试用，不生成正式能力等级。" if pilot_ready else
        "当前题库的分层题量或来源多样性不足，暂不能组建完整试卷。"}


@router.post("/assessments")
def create_assessment(request: CreateAssessmentRequest, response: Response, db: Db):
    if not config.ASSESSMENT_ENABLED:
        store.fail("ASSESSMENT_DISABLED")
    record, created = store.create(db, request, bank.QUESTION_BANK, bank.BANK_VERSION)
    response.status_code = 201 if created else 200
    return {"assessment": store.public(record)}


@router.get("/profiles/{profile_id}/assessments")
def list_assessments(profile_id: str, db: Db):
    return {"assessments": store.summaries(db, profile_id)}


@router.get("/assessments/{assessment_id}")
def get_assessment(assessment_id: str, db: Db):
    return {"assessment": store.public(store.get_session(db, assessment_id))}


@router.post("/assessments/{assessment_id}/commands")
def command_assessment(assessment_id: str, request: AssessmentCommand, db: Db,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None):
    if idempotency_key is None or not idempotency_key.strip() or len(idempotency_key) > 255:
        raise HTTPException(400, detail={"code": "IDEMPOTENCY_KEY_REQUIRED"})
    return store.command(db, assessment_id, request, idempotency_key)


class LessonAbilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ability_level: Literal["L1", "L2", "L3"] | None
    dimension_tags: list[Literal["vocabulary", "syntax", "context", "chapter", "translation", "transfer"]] = Field(max_length=6)
    expected_version: int = Field(strict=True, ge=0)
    expected_content_version: str = Field(pattern=r"^[a-f0-9]{12}$")
    actor: str = Field(min_length=1, max_length=80)
    note: str = Field(min_length=1, max_length=2000)

    @field_validator("actor", "note")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("attribution required")
        return value.strip()

    @field_validator("dimension_tags")
    @classmethod
    def unique_tags(cls, tags):
        if len(set(tags)) != len(tags):
            raise ValueError("duplicate dimension tags")
        return tags


def ability_payload(db, lesson_id):
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        store.fail("LESSON_NOT_FOUND", 404)
    # Lazy import reuses the editorial fingerprint after all routes are registered.
    try:
        from backend.main import _editorial_hash
    except ModuleNotFoundError:
        from main import _editorial_hash
    current_content_version = _editorial_hash(db, lesson)[:12]
    row = db.get(LessonAbility, lesson_id, populate_existing=True)
    return {"lesson_id": lesson_id, "ability_level": row.ability_level if row else None,
        "dimension_tags": row.dimension_tags if row else [], "version": row.version if row else 0,
        "actor": row.actor if row else None, "note": (row.note or "") if row else "",
        "updated_at": store.utc_iso(row.updated_at) if row else None,
        "content_version": row.content_version if row else None,
        "current_content_version": current_content_version,
        "valid_for_content": bool(row and row.content_version == current_content_version)}


@router.get("/admin/lessons/{lesson_id}/ability")
def get_lesson_ability(lesson_id: str, db: Db):
    return {"ability": ability_payload(db, lesson_id)}


@router.patch("/admin/lessons/{lesson_id}/ability")
def set_lesson_ability(lesson_id: str, request: LessonAbilityRequest, db: Db):
    from datetime import datetime, timezone
    current = ability_payload(db, lesson_id)
    if current["version"] != request.expected_version:
        store.fail("ABILITY_VERSION_CONFLICT", current_version=current["version"])
    if current["current_content_version"] != request.expected_content_version:
        store.fail("ABILITY_CONTENT_VERSION_CONFLICT", current_content_version=current["current_content_version"])
    values = {"ability_level": request.ability_level, "dimension_tags": request.dimension_tags,
        "version": current["version"] + 1, "actor": request.actor, "note": request.note,
        "updated_at": datetime.now(timezone.utc), "content_version": request.expected_content_version}
    if current["version"] == 0:
        db.add(LessonAbility(lesson_id=lesson_id, **values))
    else:
        changed = db.execute(update(LessonAbility).where(LessonAbility.lesson_id == lesson_id,
            LessonAbility.version == request.expected_version).values(**values), execution_options={"synchronize_session": False})
        if changed.rowcount != 1:
            db.rollback()
            store.fail("ABILITY_VERSION_CONFLICT")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        store.fail("ABILITY_VERSION_CONFLICT")
    return get_lesson_ability(lesson_id, db)
