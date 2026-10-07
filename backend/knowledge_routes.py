"""Local-only annotation editorial workbench. Production must add authorization."""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

try:
    from backend.db.session import get_db
    from backend.db.models import AnnotationHead, KnowledgeOccurrence, ReadingDocument
    from backend.db.annotation_review import annotation_row, detail, history, revise
    from backend.db.knowledge import current_corpus, document_id
    from backend.schemas import AnnotationEditRequest, AnnotationReviewRequest
except ModuleNotFoundError:
    from db.session import get_db
    from db.models import AnnotationHead, KnowledgeOccurrence, ReadingDocument
    from db.annotation_review import annotation_row, detail, history, revise
    from db.knowledge import current_corpus, document_id
    from schemas import AnnotationEditRequest, AnnotationReviewRequest

router = APIRouter(prefix="/api/v1/admin/knowledge")
Db = Annotated[Session, Depends(get_db)]


@router.get("/annotations")
def annotations(db: Db, document: str = Query(min_length=1, max_length=36),
                status: Literal["ALL", "DRAFT", "APPROVED"] = "ALL",
                q: str = Query(default="", max_length=80), offset: int = Query(default=0, ge=0),
                limit: int = Query(default=25, ge=1, le=50)):
    ids = [document_id(source, context) for source, context in current_corpus().items()]
    query = select(KnowledgeOccurrence).outerjoin(AnnotationHead).where(
        KnowledgeOccurrence.kind == "ANNOTATION", KnowledgeOccurrence.document_id == document,
        KnowledgeOccurrence.document_id.in_(ids))
    if status == "APPROVED":
        query = query.where(AnnotationHead.payload["status"].as_string() == "APPROVED")
    elif status == "DRAFT":
        query = query.where((AnnotationHead.annotation_id.is_(None)) | (AnnotationHead.payload["status"].as_string() == "DRAFT"))
    if q.strip():
        query = query.where(KnowledgeOccurrence.surface.contains(q.strip(), autoescape=True))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(KnowledgeOccurrence.paragraph_index, KnowledgeOccurrence.start,
        KnowledgeOccurrence.end, KnowledgeOccurrence.id).offset(offset).limit(limit)).all()
    return {"total": total, "items": [detail(db, row) for row in rows]}


@router.get("/annotations/{annotation_id}")
def get_annotation(annotation_id: str, db: Db):
    return {"annotation": detail(db, annotation_row(db, annotation_id)), "history": history(db, annotation_id)}


@router.patch("/annotations/{annotation_id}")
def edit_annotation(annotation_id: str, request: AnnotationEditRequest, db: Db):
    revise(db, annotation_id, request, "EDIT")
    return get_annotation(annotation_id, db)


@router.post("/annotations/{annotation_id}/review")
def review_annotation(annotation_id: str, request: AnnotationReviewRequest, db: Db):
    revise(db, annotation_id, request, "REVIEW")
    return get_annotation(annotation_id, db)
