"""Persistent, version-bound word occurrences and read-only lookup queries."""
from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5
from unicodedata import category

from sqlalchemy import and_, case, func, not_, or_, select
from sqlalchemy.orm import Session

try:
    from backend.domain.knowledge import corpus_hash, locate_annotation, selection_for, sentence_for
    from backend.domain.reading_context import reading_context_for
except ModuleNotFoundError:
    from domain.knowledge import corpus_hash, locate_annotation, selection_for, sentence_for
    from domain.reading_context import reading_context_for
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument
from .annotation_review import effective
from .seed import SEEDS


def current_corpus() -> dict[str, dict]:
    corpus: dict[str, dict] = {}
    for lesson in SEEDS:
        for payload in lesson["contents"].values():
            context = reading_context_for(payload)
            source = payload["source"]
            if source in corpus and corpus[source] != context:
                raise ValueError(f"conflicting canonical context for {source}")
            corpus[source] = context
    return corpus


def document_id(source: str, context: dict) -> str:
    return str(uuid5(NAMESPACE_URL, f"wenyan:reading-document:{corpus_hash(source, context)}"))


def seed_knowledge(db: Session, annotations: list[dict] | None = None, corpus: dict[str, dict] | None = None) -> None:
    """Add missing versions/occurrences only; never overwrite authored rows.

    Validate every draft before inserting any documents. A stale anchor is a
    startup error, rather than a silently reduced coverage claim.
    """
    if annotations is None:
        try:
            from backend.domain.knowledge_annotations import ANNOTATIONS
        except ModuleNotFoundError:
            from domain.knowledge_annotations import ANNOTATIONS
        annotations = ANNOTATIONS
    corpus = corpus if corpus is not None else current_corpus()
    positioned: dict[str, list[dict]] = {source: [] for source in corpus}
    if not isinstance(annotations, list):
        raise ValueError("ANNOTATIONS must be a list")
    input_keys = set()
    for index, annotation in enumerate(annotations):
        if not isinstance(annotation, dict) or annotation.get("source") not in corpus:
            raise ValueError(f"annotation {index}: unknown source")
        try:
            located = locate_annotation(corpus[annotation["source"]], annotation)
            key = (annotation["source"], located["paragraph_index"], located["start"], located["end"], located["sense_key"])
            if key in input_keys:
                raise ValueError("duplicate annotation position/sense key")
            input_keys.add(key)
            positioned[annotation["source"]].append(located)
        except ValueError as error:
            raise ValueError(f"annotation {index} ({annotation['source']}): {error}") from error
    for source, context in corpus.items():
        doc_id = document_id(source, context)
        document = db.get(ReadingDocument, doc_id)
        if document is None:
            db.add(ReadingDocument(id=doc_id, source=source, corpus_hash=corpus_hash(source, context), context=context))
            db.flush()
        existing_keys = set(db.scalars(select(KnowledgeOccurrence.occurrence_key).where(KnowledgeOccurrence.document_id == doc_id)).all())
        for paragraph_index, paragraph in enumerate(context["paragraphs"]):
            for start, surface in enumerate(paragraph):
                key = f"position:{paragraph_index}:{start}"
                if key not in existing_keys:
                    db.add(KnowledgeOccurrence(
                        id=str(uuid5(NAMESPACE_URL, f"{doc_id}:{key}")), document_id=doc_id, occurrence_key=key,
                        kind="POSITION", paragraph_index=paragraph_index, start=start, end=start + 1,
                        surface=surface, sentence=sentence_for(paragraph, start, start + 1), status="DRAFT",
                    ))
        for annotation in positioned[source]:
            key = f"annotation:{annotation['paragraph_index']}:{annotation['start']}:{annotation['end']}:{annotation['sense_key']}"
            if key in existing_keys:
                # Withdraw only our exact initial, unverified pronunciation
                # draft. Never change a teacher-authored variation or other row.
                if source == "《宋史·范仲淹传》" and annotation["sense_key"] == "name.zhu_yue":
                    previous = db.scalar(select(KnowledgeOccurrence).where(
                        KnowledgeOccurrence.id == str(uuid5(NAMESPACE_URL, f"{doc_id}:{key}")),
                        KnowledgeOccurrence.document_id == doc_id,
                        KnowledgeOccurrence.occurrence_key == key,
                        KnowledgeOccurrence.kind == "ANNOTATION",
                        KnowledgeOccurrence.surface == annotation["token"],
                        KnowledgeOccurrence.paragraph_index == annotation["paragraph_index"],
                        KnowledgeOccurrence.start == annotation["start"],
                        KnowledgeOccurrence.end == annotation["end"],
                        KnowledgeOccurrence.sentence == annotation["sentence"],
                        KnowledgeOccurrence.sense_key == annotation["sense_key"],
                        KnowledgeOccurrence.status == "DRAFT",
                        KnowledgeOccurrence.meaning == "改名后的名，读 yuè。",
                        KnowledgeOccurrence.part_of_speech == "人名",
                        KnowledgeOccurrence.variability == "CONTEXTUAL",
                        KnowledgeOccurrence.reasoning == "前面的名和后文更其名说明这是人名，不能按说话读解。",
                    ))
                    if previous is not None:
                        previous.meaning = annotation["meaning"]
                continue
            # A duplicated key in the authored input is an error, not two
            # meanings accidentally assigned the same database identity.
            existing_keys.add(key)
            db.add(KnowledgeOccurrence(
                id=str(uuid5(NAMESPACE_URL, f"{doc_id}:{key}")), document_id=doc_id, occurrence_key=key,
                kind="ANNOTATION", paragraph_index=annotation["paragraph_index"], start=annotation["start"], end=annotation["end"],
                surface=annotation["token"], sentence=annotation["sentence"], sense_key=annotation["sense_key"],
                meaning=annotation["meaning"], part_of_speech=annotation["part_of_speech"], variability=annotation["variability"],
                reasoning=annotation["reasoning"], status="DRAFT",
            ))
    db.flush()


def _annotation_rows(db: Session, ids: list[str]) -> list[KnowledgeOccurrence]:
    if not ids:
        return []
    return list(db.scalars(select(KnowledgeOccurrence).where(KnowledgeOccurrence.document_id.in_(ids), KnowledgeOccurrence.kind == "ANNOTATION").order_by(KnowledgeOccurrence.document_id, KnowledgeOccurrence.paragraph_index, KnowledgeOccurrence.start, KnowledgeOccurrence.end, KnowledgeOccurrence.sense_key)).all())


def _document_payload(db: Session, document: ReadingDocument, annotations: list[KnowledgeOccurrence] | None = None) -> dict:
    rows = annotations if annotations is not None else _annotation_rows(db, [document.id])
    positions = db.scalars(select(KnowledgeOccurrence).where(KnowledgeOccurrence.document_id == document.id, KnowledgeOccurrence.kind == "POSITION")).all()
    paragraphs = document.context["paragraphs"]
    covered = {(row.paragraph_index, index) for row in rows for index in range(row.start, row.end)
               if 0 <= row.paragraph_index < len(paragraphs) and 0 <= index < len(paragraphs[row.paragraph_index])
               and category(paragraphs[row.paragraph_index][index])[0] in "LN"}
    approved_ids = set(db.scalars(select(AnnotationHead.annotation_id).join(KnowledgeOccurrence)
        .where(KnowledgeOccurrence.document_id == document.id,
               AnnotationHead.payload["status"].as_string() == "APPROVED")).all())
    return {
        "id": document.id, "source": document.source, "extent": document.context.get("extent", "EXCERPT"),
        "indexed_positions": sum(category(row.surface)[0] in "LN" for row in positions),
        "codepoint_positions": len(positions), "annotated_positions": len(covered), "total_annotations": len(rows),
        "approved_annotations": len(approved_ids),
    }


def knowledge_coverage(db: Session) -> dict:
    documents = []
    for source, context in sorted(current_corpus().items()):
        document = db.get(ReadingDocument, document_id(source, context))
        if document:
            documents.append(_document_payload(db, document))
    return {"documents": documents, "totals": {
        "documents": len(documents),
        "indexed_positions": sum(item["indexed_positions"] for item in documents),
        "codepoint_positions": sum(item["codepoint_positions"] for item in documents),
        "annotated_positions": sum(item["annotated_positions"] for item in documents),
        "annotations": sum(item["total_annotations"] for item in documents),
        "approved_annotations": sum(item["approved_annotations"] for item in documents),
    }}


def knowledge_lookup(db: Session, snapshot: dict, paragraph_index: int, start: int, end: int, offset: int = 0, limit: int = 5) -> dict:
    context = snapshot.get("reading_context")
    source = snapshot.get("source", "")
    # Old sessions without frozen context cannot safely borrow today's edition.
    if not isinstance(context, dict) or not context.get("paragraphs"):
        return {"document": None, "selection": None, "annotations": [], "related": {"total": 0, "items": []}, "status": "UNAVAILABLE"}
    selected = selection_for(context, paragraph_index, start, end)
    document = db.get(ReadingDocument, document_id(source, context))
    if document is None:
        return {"document": None, "selection": selected, "annotations": [], "related": {"total": 0, "items": []}, "status": "UNAVAILABLE"}
    rows = _annotation_rows(db, [document.id])
    hits = [row for row in rows if row.paragraph_index == paragraph_index and row.start < end and row.end > start]
    annotations = [{
        "id": row.id, "token": row.surface, "start": row.start, "end": row.end, "meaning": row.meaning,
        "part_of_speech": row.part_of_speech, "variability": row.variability, "reasoning": row.reasoning,
        "sense_key": row.sense_key, **effective(db, row, document),
    } for row in hits]
    related_items = []
    related_total = 0
    if hits:
        current_ids = [document_id(name, data) for name, data in current_corpus().items()]
        current_documents = {doc.id: doc for doc in db.scalars(select(ReadingDocument).where(ReadingDocument.id.in_(current_ids))).all()}
        sense_keys = {row.sense_key for row in hits}
        surfaces = {row.surface for row in hits} | {selected["token"]}
        # Filter, count, order and paginate in SQL. Increasing the corpus must
        # not fetch every annotated word just to display five examples.
        query = select(KnowledgeOccurrence).join(ReadingDocument).where(
            KnowledgeOccurrence.kind == "ANNOTATION",
            KnowledgeOccurrence.document_id.in_(list(current_documents)),
            or_(KnowledgeOccurrence.sense_key.in_(sense_keys), KnowledgeOccurrence.surface.in_(surfaces)),
            not_(and_(KnowledgeOccurrence.document_id == document.id,
                      KnowledgeOccurrence.paragraph_index == paragraph_index,
                      KnowledgeOccurrence.start < end, KnowledgeOccurrence.end > start)),
        )
        related_total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        query = query.order_by(
            case((KnowledgeOccurrence.sense_key.in_(sense_keys), 0), else_=1),
            ReadingDocument.source, KnowledgeOccurrence.paragraph_index,
            KnowledgeOccurrence.start, KnowledgeOccurrence.end, KnowledgeOccurrence.meaning,
        ).offset(offset).limit(limit)
        for row in db.scalars(query).all():
            related_document = current_documents[row.document_id]
            if related_document is None or (row.document_id == document.id and row.paragraph_index == paragraph_index and row.start < end and row.end > start):
                continue
            same_sense = row.sense_key in sense_keys
            if not same_sense and row.surface not in surfaces:
                continue
            related_items.append({
                "source": related_document.source, "token": row.surface, "meaning": row.meaning, "sentence": row.sentence,
                "paragraph_index": row.paragraph_index, "start": row.start, "end": row.end,
                "relation": "SAME_SENSE" if same_sense else "OTHER_SENSE", **effective(db, row, related_document),
            })
    return {
        "document": _document_payload(db, document, rows), "selection": selected, "annotations": annotations,
        "related": {"total": related_total, "items": related_items},
        "status": "ANNOTATED" if hits else "PENDING",
    }
