"""Local editorial revisions, independent of seed and frozen training data."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .models import AnnotationHead, AnnotationRevision, KnowledgeOccurrence, ReadingDocument


def effective(db, row, document):
    head = db.get(AnnotationHead, row.id)
    return dict(head.payload) if head else baseline(row, document)


def baseline(row, document):
    return {
        "meaning": row.meaning, "part_of_speech": row.part_of_speech,
        "variability": row.variability, "reasoning": row.reasoning,
        "source_url": document.context.get("source_url", ""), "citation": "",
        "status": "DRAFT", "version": 0, "reviewer": None, "reviewed_at": None,
    }


def annotation_row(db, annotation_id):
    row = db.get(KnowledgeOccurrence, annotation_id)
    if row is None or row.kind != "ANNOTATION":
        raise HTTPException(404, detail={"code": "ANNOTATION_NOT_FOUND"})
    return row


def detail(db, row):
    document = db.get(ReadingDocument, row.document_id)
    return {"id": row.id, "document_id": row.document_id, "source": document.source,
            "token": row.surface, "sentence": row.sentence, "paragraph_index": row.paragraph_index,
            "start": row.start, "end": row.end, "sense_key": row.sense_key,
            **effective(db, row, document)}


def revise(db, annotation_id, request, action):
    row = annotation_row(db, annotation_id)
    current = detail(db, row)
    if current["version"] != request.expected_version:
        raise HTTPException(409, detail={"code": "ANNOTATION_VERSION_CONFLICT"})
    payload = {key: current[key] for key in (
        "meaning", "part_of_speech", "variability", "reasoning", "source_url", "citation",
        "status", "version", "reviewer", "reviewed_at")}
    if action == "EDIT":
        changes = request.model_dump(exclude={"expected_version", "actor", "note"})
        if all(payload[key] == value for key, value in changes.items()):
            return current
        payload.update(changes, status="DRAFT", reviewer=None, reviewed_at=None)
    else:
        if not payload["citation"].strip() or not payload["source_url"]:
            raise HTTPException(422, detail={"code": "ANNOTATION_SOURCE_REQUIRED"})
        if payload["status"] == "APPROVED":
            return current
        payload.update(status="APPROVED", reviewer=request.actor,
                       reviewed_at=datetime.now(timezone.utc).isoformat())
    payload["version"] += 1
    head = db.get(AnnotationHead, row.id)
    try:
        if head is None:
            db.add(AnnotationHead(annotation_id=row.id, version=payload["version"], payload=payload))
        else:
            result = db.execute(update(AnnotationHead).where(
                AnnotationHead.annotation_id == row.id, AnnotationHead.version == request.expected_version
            ).values(version=payload["version"], payload=payload))
            if result.rowcount != 1:
                db.rollback()
                raise HTTPException(409, detail={"code": "ANNOTATION_VERSION_CONFLICT"})
        db.add(AnnotationRevision(annotation_id=row.id, version=payload["version"], action=action,
                                  payload=payload, actor=request.actor, note=request.note))
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, detail={"code": "ANNOTATION_VERSION_CONFLICT"}) from error
    db.expire_all()
    return detail(db, row)


def history(db, annotation_id):
    original = annotation_row(db, annotation_id)
    document = db.get(ReadingDocument, original.document_id)
    rows = db.scalars(select(AnnotationRevision).where(AnnotationRevision.annotation_id == annotation_id)
                      .order_by(AnnotationRevision.version.desc())).all()
    return [{"version": row.version, "action": row.action, "actor": row.actor, "note": row.note,
             "created_at": row.created_at.isoformat(), "payload": row.payload} for row in rows] + [
        {"version": 0, "action": "SEED", "actor": "原始整理草稿", "note": "未人工审核，原始入库记录",
         "created_at": document.created_at.isoformat(), "payload": baseline(original, document)}]
