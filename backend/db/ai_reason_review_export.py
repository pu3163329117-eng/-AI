"""Read-only, version-bound handover bundles. No model, learner or settings access."""
from collections import defaultdict
from datetime import datetime, timezone

from fastapi.responses import JSONResponse
from sqlalchemy import select

from .ai_reason_review import fail, render_detail, render_listing, suite
from .ai_reason_review_models import AIReasonReviewNote

FORMAT_VERSION = "ai-reason-review-bundle-v1"
MAX_EXPORT_BYTES = 8 * 1024 * 1024
COMPARISON_FIELDS = ("decision", "context_sufficiency", "suggested_labels")


def compare_fields(case):
    """Compare structured values only, never certify the people or their opinions."""
    notes = case["notes"]
    differing = []
    for field in COMPARISON_FIELDS:
        values = [frozenset(n["fields"][field]) if field == "suggested_labels"
                  else n["fields"][field] for n in notes]
        if len(set(values)) > 1:
            differing.append(field)
    status = ("NO_OPINION" if not notes else "ONE_OPINION" if len(notes) == 1
              else "FIELDS_DIFFER" if differing else "FIELDS_MATCH")
    return {"case_id": case["case_id"], "note_count": len(notes),
            "status": status, "differing_fields": differing}


def bundle(db):
    """Build once and select once, so every section shares the same opinion snapshot."""
    cases, header = suite()
    with db.no_autoflush:
        records = db.scalars(select(AIReasonReviewNote)).all()
    by_case = defaultdict(list)
    for record in records:
        by_case[record.case_id].append(record)
    details = [render_detail(case, header, by_case[case["id"]]) for case in cases]
    return {**header, "format_version": FORMAT_VERSION,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "contains_self_entered_names": True,
            "queue": render_listing(cases, header, records), "cases": details,
            "comparison": [compare_fields(case) for case in details]}


def export_response(db):
    """Use the actual response encoding for the hard byte limit; never truncate."""
    content = bundle(db)
    response = JSONResponse(content, headers={
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="ai-reason-review-bundle.json"',
    })
    if len(response.body) > MAX_EXPORT_BYTES:
        fail("AI_REVIEW_EXPORT_TOO_LARGE", 413)
    return response
