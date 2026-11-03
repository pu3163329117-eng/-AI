"""Read-only current-corpus editorial counts, not scholarly verification.

APPROVED means the existing annotation head has a signed-review state. It is
not evidence that a reviewer's identity or an interpretation was verified.
Missing citation/source counts check blank fields only, never source validity.
"""
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from .knowledge import current_corpus, document_id
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument


COUNT_FIELDS = ("annotations", "draft", "approved", "missing_citation", "missing_source_url")
# SQLite trim defaults to ASCII spaces; editorial fields can also contain tabs,
# newlines, NBSP and full-width spaces. Match Python str.strip's whitespace set.
_WHITESPACE = " \t\n\r\v\f\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
_MAX_SAFE_INTEGER = 2 ** 53 - 1


def _safe_count(value: int) -> int:
    value = int(value or 0)
    if not 0 <= value <= _MAX_SAFE_INTEGER:
        raise ValueError("ANNOTATION_QUALITY_COUNT_OUT_OF_RANGE")
    return value


def annotation_quality(db: Session) -> dict:
    """One SQL statement gives a coherent aggregate without N+1 or writes.

Do not seed missing documents or include historical document versions. A head
overrides all baseline fields, including an explicitly blank source URL. The
seed baseline is DRAFT with no citation, matching annotation_review.baseline.
"""
    ids = [document_id(source, context) for source, context in current_corpus().items()]
    documents = []
    if ids:
        occurrence = KnowledgeOccurrence
        head = AnnotationHead
        present = occurrence.id.is_not(None)
        approved = and_(present, head.payload["status"].as_string() == "APPROVED")
        citation = case((head.annotation_id.is_not(None), head.payload["citation"].as_string()), else_="")
        source_url = case((head.annotation_id.is_not(None), head.payload["source_url"].as_string()),
                          else_=ReadingDocument.context["source_url"].as_string())

        def missing(field):
            return func.sum(case((and_(present, func.trim(func.coalesce(field, ""), _WHITESPACE) == ""), 1), else_=0))

        query = select(
            ReadingDocument.id, ReadingDocument.source,
            func.count(occurrence.id).label("annotations"),
            func.sum(case((approved, 1), else_=0)).label("approved"),
            missing(citation).label("missing_citation"),
            missing(source_url).label("missing_source_url"),
        ).outerjoin(occurrence, and_(occurrence.document_id == ReadingDocument.id,
                                    occurrence.kind == "ANNOTATION"))\
         .outerjoin(head, head.annotation_id == occurrence.id)\
         .where(ReadingDocument.id.in_(ids))\
         .group_by(ReadingDocument.id, ReadingDocument.source)\
         .order_by(ReadingDocument.source, ReadingDocument.id)
        # Also remain read-only when invoked with a caller's autoflush session.
        with db.no_autoflush:
            for row in db.execute(query).mappings():
                item = {"id": row["id"], "source": row["source"],
                        **{key: _safe_count(row[key]) for key in COUNT_FIELDS if key != "draft"}}
                item["draft"] = _safe_count(item["annotations"] - item["approved"])
                documents.append(item)
    totals = {"documents": _safe_count(len(documents)),
              **{key: _safe_count(sum(item[key] for item in documents)) for key in COUNT_FIELDS}}
    return {"version": "annotation-quality-v1", "totals": totals, "documents": documents}
