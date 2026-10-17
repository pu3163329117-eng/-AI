"""Loopback-only manual opinion notebook, not a certified review endpoint."""
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

try:
    from backend.ai.review_contracts import ReviewRequest
    from backend.ai_routes import local_preview_only
    from backend.db.ai_reason_review import append, detail, listing
    from backend.db.ai_reason_review_export import export_response
    from backend.db.session import get_db
except ModuleNotFoundError:
    from ai.review_contracts import ReviewRequest
    from ai_routes import local_preview_only
    from db.ai_reason_review import append, detail, listing
    from db.ai_reason_review_export import export_response
    from db.session import get_db

router = APIRouter(prefix="/api/v1/admin/ai-reason-review", dependencies=[Depends(local_preview_only)])
Db = Annotated[Session, Depends(get_db)]


@router.get("/export")
def export(db: Db):
    return export_response(db)


@router.get("/cases")
def cases(db: Db):
    return listing(db)


@router.get("/cases/{case_id}")
def case(case_id: str, db: Db):
    return detail(db, case_id)


@router.post("/cases/{case_id}/notes")
def save(case_id: str, request: ReviewRequest, db: Db,
         key: Annotated[str | None, Header(alias="Idempotency-Key")] = None):
    return append(db, case_id, request, key)
