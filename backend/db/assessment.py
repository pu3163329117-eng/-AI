"""Transactional frozen sessions and immutable command receipts."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .assessment_models import AssessmentQuestionRevision, AssessmentSession, AssessmentReceipt, AssessmentResult
from .assessment_editorial_models import AssessmentQuestionHead
from .models import LearnerProfile
try:
    from backend.domain import assessment as domain
except ModuleNotFoundError:
    from domain import assessment as domain


def fail(code, status=409, **details):
    raise HTTPException(status, detail={"code": code, **details})


def utc_iso(value):
    """SQLite strips tzinfo from our UTC defaults; preserve the instant on the wire."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def ensure_profile(db, profile_id):
    if db.get(LearnerProfile, profile_id) is None:
        fail("PROFILE_NOT_FOUND", 404)


def get_session(db, session_id):
    record = db.get(AssessmentSession, session_id, populate_existing=True)
    if record is None:
        fail("ASSESSMENT_NOT_FOUND", 404)
    return record


def public(record):
    snapshot = record.snapshot
    return {"id": record.id, "profile_id": record.profile_id, "mode": record.mode, "status": record.status,
        "state_version": record.state_version, "created_at": utc_iso(record.created_at),
        "updated_at": utc_iso(record.updated_at), "bank_version": snapshot["bank_version"],
        "scoring_version": snapshot["scoring_version"], "self_level": snapshot["self_level"],
        "self_answers": deepcopy(snapshot.get("self_answers", {})), "current_index": snapshot["current_index"],
        "questions": domain.public_questions(snapshot["questions"]), "answers": deepcopy(snapshot["answers"]),
        "result": deepcopy(snapshot["result"]) if record.status == "COMPLETED" else None}


def summaries(db, profile_id):
    ensure_profile(db, profile_id)
    records = db.scalars(select(AssessmentSession).where(AssessmentSession.profile_id == profile_id)
                         .order_by(AssessmentSession.created_at.desc(), AssessmentSession.id.desc())).all()
    result = []
    for record in records:
        item = public(record)
        questions = item.pop("questions")
        answers = item.pop("answers")
        item.update(question_count=len(questions), answered_count=sum(v is not None for v in answers.values()),
                    skipped_count=sum(v is None for v in answers.values()))
        result.append(item)
    return result


def seed_assessment_bank(db, questions=None, bank_version=None):
    """Add missing immutable revisions only. Existing attribution is never replaced."""
    if questions is None:
        try:
            from backend.domain.assessment_bank import QUESTION_BANK, BANK_VERSION
        except ModuleNotFoundError:
            from domain.assessment_bank import QUESTION_BANK, BANK_VERSION
        questions, bank_version = QUESTION_BANK, BANK_VERSION
    for question in domain.candidate_questions(questions):
        if db.get(AssessmentQuestionRevision, (question["id"], str(question["version"]))) is None:
            db.add(AssessmentQuestionRevision(question_id=question["id"], version=str(question["version"]),
                bank_version=bank_version, payload=deepcopy(question)))
    db.flush()


def bank_questions(db, bank):
    """Current bank identifies versions; persisted revisions are authoritative."""
    result = []
    for question in domain.candidate_questions(bank):
        head = db.get(AssessmentQuestionHead, question["id"], populate_existing=True)
        revision = db.get(AssessmentQuestionRevision, (question["id"], head.revision_version if head else str(question["version"])))
        if revision is not None:
            result.append(deepcopy(revision.payload))
    return result


def create(db, request, bank, bank_version):
    ensure_profile(db, request.profile_id)
    active_key = f"{request.profile_id}:{request.mode}"
    existing = db.scalar(select(AssessmentSession).where(AssessmentSession.active_key == active_key))
    if existing:
        return existing, False
    effective_bank = bank_questions(db, bank)
    try:
        questions = domain.select_questions(effective_bank, request.mode == "FORMAL")
    except ValueError as exc:
        fail(str(exc))
    if any(q.get("editorial") for q in effective_bank):
        identity = json.dumps(sorted((q["id"], str(q["version"])) for q in effective_bank), separators=(",", ":"))
        bank_version = f"{bank_version}:{hashlib.sha256(identity.encode()).hexdigest()[:12]}"
    snapshot = {"mode": request.mode, "status": "IN_PROGRESS", "bank_version": bank_version,
        "scoring_version": domain.SCORING_VERSION, "scoring_config": deepcopy(domain.SCORING_CONFIG), "self_level": request.self_level,
        "self_answers": request.self_answers, "questions": questions, "answers": {}, "current_index": 0, "result": None}
    record = AssessmentSession(profile_id=request.profile_id, mode=request.mode, status="IN_PROGRESS",
        active_key=active_key, snapshot=snapshot, state_version=0)
    db.add(record)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(AssessmentSession).where(AssessmentSession.active_key == active_key))
        if existing:
            return existing, False
        fail("ASSESSMENT_CREATE_CONFLICT")
    db.refresh(record)
    return record, True


def request_hash(request):
    encoded = json.dumps(request.model_dump(exclude_none=True), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def receipt(db, session_id, key, digest):
    saved = db.scalar(select(AssessmentReceipt).where(AssessmentReceipt.session_id == session_id,
                                                   AssessmentReceipt.idempotency_key == key))
    if saved:
        if saved.request_hash != digest:
            fail("IDEMPOTENCY_KEY_REUSED")
        return deepcopy(saved.response)
    return None


def command(db, session_id, request, key):
    digest = request_hash(request)
    previous = receipt(db, session_id, key, digest)
    if previous is not None:
        return previous
    record = get_session(db, session_id)
    if request.expected_state_version != record.state_version:
        fail("VERSION_CONFLICT", current_state_version=record.state_version)
    try:
        next_snapshot = domain.transition(record.snapshot, request.type, request.payload.model_dump(exclude_none=True))
    except ValueError as exc:
        fail(str(exc), 409 if str(exc) == "ASSESSMENT_NOT_ACTIVE" else 422)
    timestamp = datetime.now(timezone.utc)
    next_status = next_snapshot["status"]
    changed = db.execute(update(AssessmentSession).where(AssessmentSession.id == record.id,
        AssessmentSession.state_version == request.expected_state_version).values(snapshot=next_snapshot,
        state_version=request.expected_state_version + 1, status=next_status, updated_at=timestamp,
        active_key=record.active_key if next_status == "IN_PROGRESS" else None), execution_options={"synchronize_session": False})
    if changed.rowcount != 1:
        db.rollback()
        previous = receipt(db, session_id, key, digest)
        if previous is not None:
            return previous
        fail("VERSION_CONFLICT")
    db.expire(record)
    response = {"assessment": public(record)}
    if next_status == "COMPLETED":
        db.add(AssessmentResult(session_id=session_id, payload=deepcopy(next_snapshot["result"])))
    db.add(AssessmentReceipt(session_id=session_id, idempotency_key=key, request_hash=digest, response=response))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = receipt(db, session_id, key, digest)
        if previous is not None:
            return previous
        fail("VERSION_CONFLICT")
    return response
