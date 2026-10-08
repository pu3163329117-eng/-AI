"""Append-only item revisions with optimistic heads and transactional receipts."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import uuid

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, OperationalError

from .assessment import fail, utc_iso
from .assessment_models import AssessmentQuestionRevision
from .assessment_editorial_models import AssessmentQuestionHead, AssessmentEditorialReceipt
try:
    from backend.domain import assessment_editorial as domain
except ModuleNotFoundError:
    from domain import assessment_editorial as domain


def current_revision(db, question_id, bank):
    head = db.get(AssessmentQuestionHead, question_id, populate_existing=True)
    if head:
        row = db.get(AssessmentQuestionRevision, (question_id, head.revision_version))
        if row is None:
            fail("ASSESSMENT_QUESTION_REVISION_MISSING", 409)
        return row, head
    authored = next((q for q in bank if q.get("id") == question_id), None)
    if authored is None:
        fail("ASSESSMENT_QUESTION_NOT_FOUND", 404)
    row = db.get(AssessmentQuestionRevision, (question_id, str(authored["version"])))
    if row is None:
        fail("ASSESSMENT_QUESTION_NOT_FOUND", 404)
    return row, None


def detail(db, question_id, bank):
    row, head = current_revision(db, question_id, bank)
    rows = db.scalars(select(AssessmentQuestionRevision).where(AssessmentQuestionRevision.question_id == question_id)
                      .order_by(AssessmentQuestionRevision.created_at.desc(), AssessmentQuestionRevision.version.desc())).all()
    def validation(payload):
        try:
            domain.validate(payload)
            return {"validation_valid": True, "validation_error": None}
        except ValueError as exc:
            return {"validation_valid": False, "validation_error": str(exc)}

    def item(revision):
        metadata = revision.payload.get("editorial", {})
        return {"version": revision.version, "action": metadata.get("action", "SEED"),
                "actor": metadata.get("actor"), "note": metadata.get("note"),
                "created_at": utc_iso(revision.created_at), "payload": deepcopy(revision.payload),
                **validation(revision.payload)}
    metadata = row.payload.get("editorial", {})
    return {"question": deepcopy(row.payload), "version": head.version if head else 0,
            "revision_version": row.version, "actor": metadata.get("actor"), "note": metadata.get("note"),
            "updated_at": utc_iso(row.created_at), "reviewer_is_authenticated": False,
            "history": [item(row)] + [item(r) for r in rows if r.version != row.version],
            **validation(row.payload)}


def listing(db, bank, dimension, status, limit, offset):
    items = [detail(db, q["id"], bank) for q in bank]
    items = [i for i in items if (not dimension or i["question"]["dimension"] == dimension)
             and (not status or i["question"]["review_status"] == status)]
    items.sort(key=lambda i: i["question"]["id"])
    return {"items": items[offset:offset + limit], "total": len(items), "limit": limit, "offset": offset,
            "disclaimer": domain.DISCLAIMER}


def receipt(db, question_id, key, digest):
    row = db.get(AssessmentEditorialReceipt, (question_id, key), populate_existing=True)
    if row:
        if row.request_hash != digest:
            fail("IDEMPOTENCY_KEY_REUSED")
        return deepcopy(row.response)
    return None


def revise(db, question_id, bank, request, action, key):
    body = json.dumps({"action": action, **request.model_dump()}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(body.encode()).hexdigest()
    saved = receipt(db, question_id, key, digest)
    if saved is not None:
        return saved
    row, head = current_revision(db, question_id, bank)
    version = head.version if head else 0
    if request.expected_version != version:
        fail("ASSESSMENT_QUESTION_VERSION_CONFLICT", current_version=version)
    revision_version = f"editorial-{version + 1}-{uuid.uuid4().hex}"
    timestamp = datetime.now(timezone.utc)
    try:
        payload = (domain.edit(row.payload, request.question.model_dump(), revision_version) if action == "EDIT"
                   else domain.review(row.payload, request.decision, request.actor, timestamp.isoformat(), revision_version))
    except ValueError as exc:
        fail(str(exc), 422)
    payload["editorial"] = {"action": action if action == "EDIT" else request.decision, "actor": request.actor, "note": request.note,
                            "head_version": version + 1, "parent_revision": row.version}
    try:
        if head is None:
            db.add(AssessmentQuestionHead(question_id=question_id, version=1, revision_version=revision_version))
        else:
            result = db.execute(update(AssessmentQuestionHead).where(AssessmentQuestionHead.question_id == question_id,
                 AssessmentQuestionHead.version == version).values(version=version + 1, revision_version=revision_version),
                 execution_options={"synchronize_session": False})
            if result.rowcount != 1:
                db.rollback()
                saved = receipt(db, question_id, key, digest)
                if saved is not None:
                    return saved
                fail("ASSESSMENT_QUESTION_VERSION_CONFLICT")
        db.add(AssessmentQuestionRevision(question_id=question_id, version=revision_version,
            bank_version=row.bank_version, payload=payload, created_at=timestamp))
        db.flush()
        db.expire_all()
        response = detail(db, question_id, bank)
        db.add(AssessmentEditorialReceipt(question_id=question_id, idempotency_key=key, request_hash=digest, response=response))
        db.commit()
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        saved = receipt(db, question_id, key, digest)
        if saved is not None:
            return saved
        if isinstance(exc, OperationalError) and not any(code in str(exc.orig).lower()
                for code in ("database is locked", "database is busy", "database table is locked")):
            fail("ASSESSMENT_EDITORIAL_STORAGE_UNAVAILABLE", 503)
        fail("ASSESSMENT_QUESTION_VERSION_CONFLICT")
    return response
