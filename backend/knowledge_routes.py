"""Local-only annotation editorial workbench. Production must add authorization."""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

try:
    from backend.db.session import get_db
    from backend.db.annotation_review import annotation_row, detail, history, revise
    from backend.db.annotation_quality import annotation_quality
    from backend.db.annotation_comparison import MAX_SAFE_INTEGER, annotation_comparisons
    from backend.db.annotation_queue import annotation_queue
    from backend.db.annotation_packet import annotation_packet
    from backend.db.knowledge_evidence import evidence_candidates
    from backend.db.knowledge import current_corpus
    from backend.schemas import AnnotationEditRequest, AnnotationReviewRequest
except ModuleNotFoundError:
    from db.session import get_db
    from db.annotation_review import annotation_row, detail, history, revise
    from db.annotation_quality import annotation_quality
    from db.annotation_comparison import MAX_SAFE_INTEGER, annotation_comparisons
    from db.annotation_queue import annotation_queue
    from db.annotation_packet import annotation_packet
    from db.knowledge_evidence import evidence_candidates
    from db.knowledge import current_corpus
    from schemas import AnnotationEditRequest, AnnotationReviewRequest

router = APIRouter(prefix="/api/v1/admin/knowledge")
Db = Annotated[Session, Depends(get_db)]


@router.get("/evidence-candidates")
def get_evidence_candidates(db: Db, document: str | None = None, token: str | None = None):
    # Inherits the existing admin guard; catalog preview is never an import.
    return evidence_candidates(db, document, token)


@router.get("/quality")
def quality(db: Db):
    # Inherits the global local/admin access gate; never enables public admin.
    return annotation_quality(db)


@router.get("/documents/{document_id}/review-packet")
def review_packet(document_id: str, db: Db):
    # Same inherited admin gate; this endpoint cannot enable public admin.
    return annotation_packet(db, document_id)


@router.get("/annotations")
def annotations(db: Db, document: str = Query(min_length=1, max_length=36),
                status: Literal["ALL", "DRAFT", "APPROVED"] = "ALL",
                q: str = Query(default="", max_length=80), offset: int = Query(default=0, ge=0, le=MAX_SAFE_INTEGER),
                limit: int = Query(default=25, ge=1, le=50),
                gap: Literal["ALL", "MISSING_CITATION", "MISSING_SOURCE_URL", "MISSING_EITHER"] = "ALL"):
    return annotation_queue(db, document, status, q, offset, limit, gap, corpus=current_corpus())


@router.get("/annotations/{annotation_id}")
def get_annotation(annotation_id: str, db: Db):
    return {"annotation": detail(db, annotation_row(db, annotation_id)), "history": history(db, annotation_id)}


@router.get("/annotations/{annotation_id}/comparisons")
def compare_annotations(annotation_id: str, db: Db,
                        expected_version: int = Query(ge=0, le=MAX_SAFE_INTEGER),
                        offset: int = Query(default=0, ge=0, le=MAX_SAFE_INTEGER),
                        limit: int = Query(default=5, ge=1, le=10)):
    return annotation_comparisons(db, annotation_id, expected_version, offset, limit)


@router.patch("/annotations/{annotation_id}")
def edit_annotation(annotation_id: str, request: AnnotationEditRequest, db: Db):
    revise(db, annotation_id, request, "EDIT")
    return get_annotation(annotation_id, db)


@router.post("/annotations/{annotation_id}/review")
def review_annotation(annotation_id: str, request: AnnotationReviewRequest, db: Db):
    revise(db, annotation_id, request, "REVIEW")
    return get_annotation(annotation_id, db)
