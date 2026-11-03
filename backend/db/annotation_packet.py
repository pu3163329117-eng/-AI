"""Bounded current-document editorial snapshot, never a scholarly attestation.

One SQL statement reads document, bounded occurrences and effective heads on the
same SQLite snapshot. No revision history, reviewer identity or learner tables
are projected. Blank head sources deliberately override original sources.
"""
import hashlib
import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Text, and_, case, cast, func, select, true
from sqlalchemy.orm import Session

from .knowledge import current_corpus, document_id
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument

VERSION = "annotation-review-packet-v1"
MAX_ITEMS = 2000
MAX_BYTES = 8 * 1024 * 1024
MAX_SAFE_INTEGER = 2 ** 53 - 1
# JSON stored with escaped Unicode may take six characters per codepoint. This
# SQL-side budget caps malformed legacy JSON before it crosses into Python.
MAX_RAW_JSON = MAX_BYTES * 6
_TEXT_LIMITS = {"id": 36, "document_id": 36, "token": 100, "sentence": 20000,
                "sense_key": 160, "meaning": 2000, "part_of_speech": 80,
                "reasoning": 4000, "citation": 2000, "source_url": 2000}
_ITEM_FIELDS = ("id", "document_id", "paragraph_index", "start", "end", "token", "sentence",
                "sense_key", "meaning", "part_of_speech", "variability", "reasoning", "status",
                "version", "citation", "source_url")


def _fail(code, status):
    raise HTTPException(status, detail={"code": "ANNOTATION_PACKET_" + code})


def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _text(value, limit, *, nullable=False, nonblank=False):
    if value is None and nullable:
        value = ""
    if not isinstance(value, str) or len(value) > limit or (nonblank and not value.strip()):
        _fail("INVALID_DATA", 503)
    return value


def _integer(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        _fail("INVALID_DATA", 503)
    return value


def canonical_bytes(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        _fail("INVALID_DATA", 503)


def _decode(value):
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError, RecursionError):
        _fail("INVALID_DATA", 503)
    if not isinstance(decoded, dict):
        _fail("INVALID_DATA", 503)
    return decoded


def annotation_packet(db: Session, document: str) -> dict:
    if not _uuid(document):
        _fail("INVALID_REQUEST", 422)
    ids = [document_id(source, context) for source, context in current_corpus().items()]
    def bounded(column, limit):
        # Retain one overflow character for validation, rather than transfer a
        # corrupt unbounded SQLite TEXT value (SQLite does not enforce VARCHAR).
        return case((func.length(column) > limit, func.substr(column, 1, limit + 1)), else_=column)

    doc = select(ReadingDocument.id, bounded(ReadingDocument.source, 200).label("source"),
                 cast(ReadingDocument.context, Text).label("context_raw"))\
        .where(ReadingDocument.id == document, ReadingDocument.id.in_(ids)).cte("packet_document")
    occurrence, head = KnowledgeOccurrence, AnnotationHead
    entries = select(occurrence.id, occurrence.document_id, occurrence.paragraph_index,
        occurrence.start, occurrence.end, bounded(occurrence.surface, 100).label("token"),
        *(bounded(getattr(occurrence, key), limit).label(key) for key, limit in
          (("sentence", 20000), ("sense_key", 160), ("meaning", 2000),
           ("part_of_speech", 80), ("variability", 20), ("reasoning", 4000))),
        head.annotation_id.label("head_id"), head.version.label("head_version"),
        cast(head.payload, Text).label("head_raw"))\
        .join(doc, doc.c.id == occurrence.document_id).outerjoin(head, head.annotation_id == occurrence.id)\
        .where(occurrence.kind == "ANNOTATION")\
        .order_by(occurrence.paragraph_index, occurrence.start, occurrence.end, occurrence.id)\
        .limit(MAX_ITEMS + 1).cte("packet_entries")
    budget = select(func.count().label("total"),
                    func.coalesce(func.sum(func.length(entries.c.head_raw)), 0).label("head_chars"))\
        .select_from(entries).cte("packet_budget")
    order = (entries.c.paragraph_index, entries.c.start, entries.c.end, entries.c.id)
    too_large = (func.length(doc.c.context_raw) + budget.c.head_chars) > MAX_RAW_JSON
    query = select(doc.c.id.label("packet_document_id"), doc.c.source, budget.c.total,
        too_large.label("raw_too_large"),
        case((and_(func.row_number().over(order_by=order) == 1, ~too_large), doc.c.context_raw),
             else_=None).label("context_raw"),
        *(entries.c[name] for name in entries.c.keys() if name != "head_raw"),
        case((~too_large, entries.c.head_raw), else_=None).label("head_raw"))\
        .select_from(doc).join(budget, true()).outerjoin(entries, true()).order_by(*order)
    with db.no_autoflush:
        rows = db.execute(query).mappings().all()
    if not rows:
        _fail("UNAVAILABLE", 404)
    if rows[0]["total"] > MAX_ITEMS or rows[0]["raw_too_large"]:
        _fail("TOO_LARGE", 413)
    context = _decode(rows[0]["context_raw"])
    paragraphs = context.get("paragraphs")
    if (not isinstance(paragraphs, list) or len(paragraphs) > 500
            or any(not isinstance(p, str) or len(p) > 20000 for p in paragraphs)):
        _fail("INVALID_DATA", 503)
    meta = {"id": document, "source": _text(rows[0]["source"], 200, nonblank=True),
            **{key: _text(context.get(key, ""), limit) for key, limit in
               (("author", 200), ("era", 200), ("text_version", 200), ("work_note", 4000))},
            "extent": context.get("extent", "EXCERPT"),
            "source_url": _text(context.get("source_url"), 2000, nullable=True), "paragraphs": paragraphs}
    if not isinstance(meta["extent"], str) or meta["extent"] not in {"FULL", "CHAPTER", "EXCERPT", "PROMPT"}:
        _fail("INVALID_DATA", 503)
    items = []
    for row in rows:
        if row["id"] is None:
            continue
        if row["head_id"] is not None:
            payload = _decode(row["head_raw"])
            if _integer(payload.get("version")) != _integer(row["head_version"]):
                _fail("INVALID_DATA", 503)
        else:
            payload = {**{key: row[key] for key in ("meaning", "part_of_speech", "variability", "reasoning")},
                       "version": 0, "status": "DRAFT", "citation": "", "source_url": meta["source_url"]}
        item = {**{key: row[key] for key in ("id", "document_id", "paragraph_index", "start", "end", "token", "sentence", "sense_key")},
                **{key: payload.get(key) for key in ("meaning", "part_of_speech", "variability", "reasoning", "status", "version", "citation", "source_url")}}
        for key, limit in _TEXT_LIMITS.items():
            item[key] = _text(item[key], limit, nullable=key in {"sense_key", "citation", "source_url"},
                              nonblank=key in {"token", "sentence", "meaning", "part_of_speech", "reasoning"})
        if not _uuid(item["id"]) or item["document_id"] != document:
            _fail("INVALID_DATA", 503)
        for key in ("paragraph_index", "start", "end", "version"):
            _integer(item[key])
        p, start, end = item["paragraph_index"], item["start"], item["end"]
        if (p >= len(paragraphs) or not start < end <= len(paragraphs[p])
                or item["token"] != paragraphs[p][start:end] or not item["token"].strip()
                or not isinstance(item["status"], str) or item["status"] not in {"DRAFT", "APPROVED"}
                or not isinstance(item["variability"], str) or item["variability"] not in {"CONTEXTUAL", "STABLE"}):
            _fail("INVALID_DATA", 503)
        items.append({key: item[key] for key in _ITEM_FIELDS})
    summary = {"annotations": len(items), "draft": 0, "approved": 0,
               "missing_citation": 0, "missing_source_url": 0, "missing_either": 0}
    for item in items:
        summary[item["status"].lower()] += 1
        no_citation, no_url = not item["citation"].strip(), not item["source_url"].strip()
        summary["missing_citation"] += int(no_citation)
        summary["missing_source_url"] += int(no_url)
        summary["missing_either"] += int(no_citation or no_url)
    packet = {"version": VERSION, "document": meta, "summary": summary, "items": items}
    packet["snapshot_sha256"] = hashlib.sha256(canonical_bytes(packet)).hexdigest()
    if len(canonical_bytes(packet)) > MAX_BYTES:
        _fail("TOO_LARGE", 413)
    return packet
