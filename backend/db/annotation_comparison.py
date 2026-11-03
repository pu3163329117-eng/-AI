"""Current-material annotation comparisons, not semantic equivalence or review.

One SELECT keeps anchor version, total and bounded page on one read snapshot.
It never merges senses, rewrites history, seeds documents or authenticates a
reviewer. SAME_KEY is only an existing key match, not a scholarly conclusion.
"""
from fastapi import HTTPException
from sqlalchemy import and_, case, func, literal, not_, or_, select, true
from sqlalchemy.orm import Session

from .annotation_quality import _WHITESPACE
from .knowledge import current_corpus, document_id
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument


MAX_SAFE_INTEGER = 2 ** 53 - 1
_ITEM_FIELDS = ("id", "document_id", "source", "paragraph_index", "start", "end", "token", "sentence",
                "sense_key", "meaning", "part_of_speech", "variability", "reasoning", "status", "version",
                "citation", "source_url", "match")


def _fail(code, status):
    raise HTTPException(status, detail={"code": code})


def annotation_comparisons(db: Session, annotation_id: str, expected_version: int,
                           offset: int = 0, limit: int = 5) -> dict:
    # Validate also direct callers: in particular, oversized offsets must not
    # overflow the SQLite integer binder or booleans masquerade as versions.
    if (any(type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER for value in (expected_version, offset))
            or type(limit) is not int or not 1 <= limit <= 10):
        _fail("ANNOTATION_COMPARISON_INVALID_REQUEST", 422)
    ids = [document_id(source, context) for source, context in current_corpus().items()]
    occurrence = KnowledgeOccurrence
    head = AnnotationHead
    has_head = head.annotation_id.is_not(None)

    def effective(field, seed):
        return case((has_head, head.payload[field].as_string()), else_=seed)

    current = select(
        occurrence.id, occurrence.document_id, ReadingDocument.source, occurrence.paragraph_index,
        occurrence.start, occurrence.end, occurrence.surface.label("token"), occurrence.sentence,
        func.coalesce(occurrence.sense_key, "").label("sense_key"),
        *(effective(field, getattr(occurrence, field)).label(field)
          for field in ("meaning", "part_of_speech", "variability", "reasoning")),
        effective("status", literal("DRAFT")).label("status"),
        case((has_head, head.version), else_=0).label("version"),
        func.coalesce(effective("citation", literal("")), "").label("citation"),
        func.coalesce(effective("source_url", ReadingDocument.context["source_url"].as_string()), "").label("source_url"),
    ).join(ReadingDocument, ReadingDocument.id == occurrence.document_id)\
     .outerjoin(head, head.annotation_id == occurrence.id)\
     .where(occurrence.kind == "ANNOTATION", occurrence.document_id.in_(ids)).cte("current_annotations")
    anchor = select(current).where(current.c.id == annotation_id).cte("comparison_anchor")

    def nonblank(column):
        return func.trim(func.coalesce(column, ""), _WHITESPACE) != ""

    same_key = and_(nonblank(anchor.c.sense_key), nonblank(current.c.sense_key),
                    current.c.sense_key == anchor.c.sense_key)
    same_token = and_(nonblank(anchor.c.token), nonblank(current.c.token), current.c.token == anchor.c.token)
    overlaps = and_(current.c.document_id == anchor.c.document_id,
                    current.c.paragraph_index == anchor.c.paragraph_index,
                    current.c.start < anchor.c.end, current.c.end > anchor.c.start)
    candidates = select(current, case((same_key, "SAME_KEY"), else_="SAME_TOKEN").label("match"),
                        case((same_key, 0), else_=1).label("rank"))\
        .select_from(current).join(anchor, true()).where(current.c.id != anchor.c.id,
            or_(same_key, same_token), not_(overlaps))\
        .cte("comparison_candidates")

    def ordering(columns):
        return (columns.rank, columns.source, columns.document_id, columns.paragraph_index,
                columns.start, columns.end, columns.id)

    page = select(candidates).order_by(*ordering(candidates.c)).offset(offset).limit(limit).cte("comparison_page")
    count = select(func.count().label("total")).select_from(candidates).cte("comparison_count")
    query = select(
        *(anchor.c[field].label("anchor_" + field) for field in ("id", "document_id", "version", "token", "sense_key")),
        count.c.total, *(page.c[field] for field in _ITEM_FIELDS),
    ).select_from(anchor).join(count, true()).outerjoin(page, true()).order_by(*ordering(page.c))
    with db.no_autoflush:
        rows = db.execute(query).mappings().all()
    if not rows:
        _fail("ANNOTATION_COMPARISON_UNAVAILABLE", 404)
    first = rows[0]
    if (type(first["anchor_version"]) is not int or not 0 <= first["anchor_version"] <= MAX_SAFE_INTEGER
            or not isinstance(first["anchor_token"], str) or not first["anchor_token"].strip()
            or len(first["anchor_token"]) > 100):
        _fail("ANNOTATION_COMPARISON_INVALID_DATA", 503)
    if first["anchor_version"] != expected_version:
        _fail("ANNOTATION_VERSION_CONFLICT", 409)
    total = first["total"]
    if type(total) is not int or not 0 <= total <= MAX_SAFE_INTEGER:
        _fail("ANNOTATION_COMPARISON_INVALID_DATA", 503)
    items = [{field: row[field] for field in _ITEM_FIELDS} for row in rows if row["id"] is not None]
    # Do not invent a classification when legacy/corrupt content cannot honor
    # the contract. These enums come only from existing seed/head data.
    if any(item["variability"] not in {"CONTEXTUAL", "STABLE"} or item["status"] not in {"DRAFT", "APPROVED"}
           or type(item["version"]) is not int or not 0 <= item["version"] <= MAX_SAFE_INTEGER
           or not isinstance(item["source_url"], str) or not isinstance(item["citation"], str)
           or not isinstance(item["token"], str) or not item["token"].strip() or len(item["token"]) > 100
           or any(type(item[field]) is not int or not 0 <= item[field] <= MAX_SAFE_INTEGER
                  for field in ("paragraph_index", "start", "end")) or item["end"] <= item["start"]
           for item in items):
        _fail("ANNOTATION_COMPARISON_INVALID_DATA", 503)
    return {"version": "annotation-comparison-v1",
            "anchor": {field: first["anchor_" + field] for field in ("id", "document_id", "version", "token", "sense_key")},
            "offset": offset, "limit": limit, "total": total, "items": items}
