"""Read-only, current-corpus editorial queue with intersecting gap filters.

Missing means a blank field, not a verdict about source reliability. A head's
blank source URL overrides the seed URL. Count and page share one SQL snapshot.
"""
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import case, func, literal, or_, select, true
from sqlalchemy.orm import Session

from .annotation_quality import _WHITESPACE
from .annotation_review import baseline
from .knowledge import current_corpus, document_id
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument


MAX_SAFE_INTEGER = 2 ** 53 - 1
GAPS = frozenset({"ALL", "MISSING_CITATION", "MISSING_SOURCE_URL", "MISSING_EITHER"})
_LOCATION = ("id", "document_id", "source", "token", "sentence", "paragraph_index", "start", "end", "sense_key")
_SEED_FIELDS = ("meaning", "part_of_speech", "variability", "reasoning")


def annotation_queue(db: Session, document: str, status: str = "ALL", q: str = "",
                     offset: int = 0, limit: int = 25, gap: str = "ALL", *, corpus=None) -> dict:
    if (not isinstance(status, str) or status not in {"ALL", "DRAFT", "APPROVED"}
            or not isinstance(gap, str) or gap not in GAPS
            or not isinstance(document, str) or not 1 <= len(document) <= 36
            or not isinstance(q, str) or len(q) > 80
            or type(offset) is not int or not 0 <= offset <= MAX_SAFE_INTEGER
            or type(limit) is not int or not 1 <= limit <= 50):
        raise HTTPException(422, detail={"code": "ANNOTATION_QUEUE_INVALID_REQUEST"})
    corpus = current_corpus() if corpus is None else corpus
    ids = [document_id(source, context) for source, context in corpus.items()]
    occurrence, head = KnowledgeOccurrence, AnnotationHead
    has_head = head.annotation_id.is_not(None)
    citation = case((has_head, head.payload["citation"].as_string()), else_=literal(""))
    source_url = case((has_head, head.payload["source_url"].as_string()),
                      else_=ReadingDocument.context["source_url"].as_string())

    def missing(field):
        return func.trim(func.coalesce(field, ""), _WHITESPACE) == ""

    query = select(
        occurrence.id, occurrence.document_id, ReadingDocument.source,
        occurrence.surface.label("token"), occurrence.sentence, occurrence.paragraph_index,
        occurrence.start, occurrence.end, occurrence.sense_key,
        *(getattr(occurrence, key).label("seed_" + key) for key in _SEED_FIELDS),
        ReadingDocument.context["source_url"].as_string().label("seed_source_url"),
        func.json_type(ReadingDocument.context, "$.source_url").label("seed_source_type"),
        head.annotation_id.label("head_id"), head.payload.label("head_payload"),
    ).join(ReadingDocument, ReadingDocument.id == occurrence.document_id)\
     .outerjoin(head, head.annotation_id == occurrence.id)\
     .where(occurrence.kind == "ANNOTATION", occurrence.document_id == document,
            occurrence.document_id.in_(ids))
    if status == "APPROVED":
        query = query.where(head.payload["status"].as_string() == "APPROVED")
    elif status == "DRAFT":
        query = query.where(or_(head.annotation_id.is_(None), head.payload["status"].as_string() == "DRAFT"))
    if q.strip():
        query = query.where(occurrence.surface.contains(q.strip(), autoescape=True))
    if gap == "MISSING_CITATION":
        query = query.where(missing(citation))
    elif gap == "MISSING_SOURCE_URL":
        query = query.where(missing(source_url))
    elif gap == "MISSING_EITHER":
        query = query.where(or_(missing(citation), missing(source_url)))

    filtered = query.cte("annotation_queue_filtered")

    def ordering(columns):
        return (columns.paragraph_index, columns.start, columns.end, columns.id)

    page = select(filtered).order_by(*ordering(filtered.c)).offset(offset).limit(limit).cte("annotation_queue_page")
    count = select(func.count().label("total")).select_from(filtered).cte("annotation_queue_count")
    statement = select(count.c.total, page).select_from(count).outerjoin(page, true()).order_by(*ordering(page.c))
    with db.no_autoflush:
        rows = db.execute(statement).mappings().all()
    total = rows[0]["total"]
    if type(total) is not int or not 0 <= total <= MAX_SAFE_INTEGER:
        raise HTTPException(503, detail={"code": "ANNOTATION_QUEUE_INVALID_DATA"})
    items = []
    for row in rows:
        if row["id"] is None:  # Count survives an empty or out-of-range page.
            continue
        if row["head_id"] is not None:
            payload = dict(row["head_payload"])
        else:
            seed = SimpleNamespace(**{key: row["seed_" + key] for key in _SEED_FIELDS})
            # Preserve baseline's .get semantics: absent key -> "", explicit
            # JSON null -> None. SQL's gap test treats both as blank, without
            # rewriting the existing managed payload sent by default ALL.
            source_context = {} if row["seed_source_type"] is None else {"source_url": row["seed_source_url"]}
            document_row = SimpleNamespace(context=source_context)
            payload = baseline(seed, document_row)
        items.append({**{key: row[key] for key in _LOCATION}, **payload})
    return {"total": total, "items": items}
