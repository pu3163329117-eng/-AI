"""Version-bound, idempotent append-only opinions. No learner or model access."""
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

try:
    from backend.ai.calibration_cases import SUITE_VERSION, build_cases, digest, suite_digest
except ModuleNotFoundError:
    from ai.calibration_cases import SUITE_VERSION, build_cases, digest, suite_digest
from .ai_reason_review_models import AIReasonReviewNote

GATES = {"review_status": "NOT_VERIFIED", "reviewer_identity_verified": False,
         "semantic_accuracy_verified": False, "may_update_learning": False,
         "live_ai_release_gate_satisfied": False}


def fail(code, status):
    raise HTTPException(status, {"code": code})


def suite():
    cases = build_cases()
    return cases, {"suite_version": SUITE_VERSION, "suite_digest": suite_digest(cases), **GATES}


def note(record):
    created = record.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return {"id": record.id, "case_id": record.case_id, "suite_digest": record.suite_digest,
            "input_digest": record.input_digest, "revision": record.revision,
            "created_at": created.isoformat(), "fields": record.fields, **GATES}


def current_records(case, header, records):
    """Bind an opinion to the current case, not merely a similarly named case."""
    return sorted((r for r in records if r.case_id == case["id"]
                   and r.suite_digest == header["suite_digest"]
                   and r.input_digest == case["input_digest"]), key=lambda r: r.revision)


def render_listing(cases, header, records):
    """Pure queue rendering, shared with the coherent read-only export."""
    inputs = {c["id"]: c["input_digest"] for c in cases}
    records = sorted((r for r in records if r.suite_digest == header["suite_digest"]
                      and inputs.get(r.case_id) == r.input_digest), key=lambda r: r.revision)
    latest = {r.case_id: r for r in records}
    counts = {state: sum(r.fields["decision"] == state for r in latest.values())
              for state in ("ACCEPTABLE", "NEEDS_REVISION", "UNCERTAIN")}
    return {**header, "total": len(cases), "recorded_cases": len(latest), "notes_total": len(records),
            "decision_counts": counts, "items": [{"case_id": c["id"], "target": c["payload"]["target"],
            "stage": c["payload"]["stage"], "source": c["source"], "input_digest": c["input_digest"],
            "revision": latest[c["id"]].revision if c["id"] in latest else 0,
            "decision": latest[c["id"]].fields["decision"] if c["id"] in latest else None} for c in cases]}


def listing(db):
    cases, header = suite()
    with db.no_autoflush:
        records = db.scalars(select(AIReasonReviewNote).where(AIReasonReviewNote.suite_digest == header["suite_digest"])).all()
    return render_listing(cases, header, records)


def render_detail(case, header, records):
    """Pure detail rendering, including counts for earlier input/suite versions."""
    records = [r for r in records if r.case_id == case["id"]]
    current = current_records(case, header, records)
    return {**header, "case_id": case["id"], "source": case["source"], "payload": case["payload"],
            "input_digest": case["input_digest"], "revision": current[-1].revision if current else 0,
            "notes": [note(r) for r in current], "historical_note_count": len(records) - len(current),
            "development_expectation": {"labels": case["expected_labels"], "error": case["expected_error"],
                "required_evidence": case["required_evidence"], "required_criteria": case["required_criteria"],
                "note": case["review_note"], "review_status": "NOT_VERIFIED"}}


def detail(db, case_id):
    cases, header = suite()
    case = next((c for c in cases if c["id"] == case_id), None)
    if case is None:
        fail("AI_REVIEW_CASE_NOT_FOUND", 404)
    with db.no_autoflush:
        records = db.scalars(select(AIReasonReviewNote).where(AIReasonReviewNote.case_id == case_id)).all()
    return render_detail(case, header, records)


def append(db, case_id, request, key):
    if not isinstance(key, str) or not 16 <= len(key) <= 64 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in key):
        fail("AI_REVIEW_KEY_REQUIRED", 400)
    request_hash = digest({"case_id": case_id, "body": request.model_dump()})
    previous = db.get(AIReasonReviewNote, key)
    if previous:
        if previous.request_hash != request_hash:
            fail("IDEMPOTENCY_KEY_REUSED", 409)
        return {"saved": note(previous), "replayed": True, **GATES}
    current = detail(db, case_id)
    if request.expected_suite_digest != current["suite_digest"] or request.expected_input_digest != current["input_digest"]:
        fail("AI_REVIEW_SUITE_CHANGED", 409)
    if request.expected_revision != current["revision"]:
        fail("AI_REVIEW_VERSION_CONFLICT", 409)
    if current["revision"] >= 100:
        fail("AI_REVIEW_HISTORY_FULL", 409)
    record = AIReasonReviewNote(id=key, request_hash=request_hash, case_id=case_id,
        suite_digest=current["suite_digest"], input_digest=current["input_digest"],
        revision=current["revision"] + 1, fields=request.fields.model_dump())
    db.add(record)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = db.get(AIReasonReviewNote, key)
        if previous and previous.request_hash == request_hash:
            return {"saved": note(previous), "replayed": True, **GATES}
        fail("IDEMPOTENCY_KEY_REUSED" if previous else "AI_REVIEW_VERSION_CONFLICT", 409)
    db.refresh(record)
    return {"saved": note(record), "replayed": False, **GATES}
