"""Resolve learner-selected annotations against the frozen session, read only."""
from .annotation_review import effective
from .knowledge import document_id
from .models import KnowledgeOccurrence, ReadingDocument

try:
    from backend.domain.knowledge import selection_for
except ModuleNotFoundError:
    from domain.knowledge import selection_for


def resolve_annotation_basis(db, snapshot, payload):
    context = snapshot.get("reading_context")
    identifier, version = payload.get("annotation_id"), payload.get("annotation_version")
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 36 or type(version) is not int or version < 0:
        raise ValueError("INVALID_EVIDENCE_BASIS")
    if not isinstance(context, dict):
        raise ValueError("ANNOTATION_EVIDENCE_UNAVAILABLE")
    try:
        selected = selection_for(context, payload.get("paragraph_index"), payload.get("start"), payload.get("end"))
    except ValueError:
        raise ValueError("INVALID_CONTEXT_SELECTION") from None
    document = db.get(ReadingDocument, document_id(snapshot.get("source", ""), context))
    row = db.get(KnowledgeOccurrence, identifier)
    if (document is None or row is None or row.kind != "ANNOTATION" or row.document_id != document.id
            or row.paragraph_index != selected["paragraph_index"] or not row.start < selected["end"]
            or not row.end > selected["start"]):
        raise ValueError("ANNOTATION_EVIDENCE_UNAVAILABLE")
    paragraph = context["paragraphs"][row.paragraph_index]
    if not 0 <= row.start < row.end <= len(paragraph) or paragraph[row.start:row.end] != row.surface:
        raise ValueError("ANNOTATION_EVIDENCE_UNAVAILABLE")
    current = effective(db, row, document)
    if current.get("version") != version:
        raise ValueError("ANNOTATION_EVIDENCE_VERSION_CONFLICT")
    if not isinstance(current.get("meaning"), str) or not current["meaning"].strip() or current.get("status") not in ("DRAFT", "APPROVED"):
        raise ValueError("ANNOTATION_EVIDENCE_UNAVAILABLE")
    return {"id": row.id, "version": version, "document_id": document.id, "source": document.source,
            "token": row.surface, "paragraph_index": row.paragraph_index, "start": row.start, "end": row.end,
            **{key: current.get(key, "") for key in ("meaning", "status", "source_url", "citation")}}
