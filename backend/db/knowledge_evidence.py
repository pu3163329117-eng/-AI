"""Read-only projection of a tiny, separately checked original-text catalog.

One bounded SELECT observes documents, occurrences and effective head pointers
on one SQLite statement snapshot. It does not seed, flush, edit, approve, merge,
or touch a learner table. AVAILABLE is only a local identity/version binding.
"""
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

try:
    from backend.domain.knowledge_evidence import BATCH_ID, TOKENS, VERSION, evidence_catalog
    from backend.domain.knowledge import corpus_hash, sentence_for
except ModuleNotFoundError:
    from domain.knowledge_evidence import BATCH_ID, TOKENS, VERSION, evidence_catalog
    from domain.knowledge import corpus_hash, sentence_for
from .knowledge import current_corpus
from .models import AnnotationHead, KnowledgeOccurrence, ReadingDocument

MAX_SAFE_INTEGER = 2 ** 53 - 1


def _valid_binding(item: dict, context: dict | None, row) -> tuple[int, str] | None:
    if not isinstance(context, dict) or row is None:
        return None
    # Check the complete saved public context, not just a claimed hash column.
    if (corpus_hash(item['source'], context) != item['corpus_hash']
            or row['document_source'] != item['source'] or row['document_hash'] != item['corpus_hash']
            or not isinstance(row['document_context'], dict)
            or corpus_hash(item['source'], row['document_context']) != item['corpus_hash']
            or context.get('text_version') != item['text_version'] or context.get('extent') != item['extent']):
        return None
    paragraphs = context.get('paragraphs')
    p, start, end = item['paragraph_index'], item['start'], item['end']
    if (not isinstance(paragraphs, list) or p >= len(paragraphs) or not isinstance(paragraphs[p], str)
            or paragraphs[p][start:end] != item['token'] or sentence_for(paragraphs[p], start, end) != item['sentence']):
        return None
    key = f"annotation:{p}:{start}:{end}:{item['sense_key']}"
    if (row['kind'] != 'ANNOTATION' or row['document_id'] != item['document_id']
            or row['occurrence_key'] != key or row['surface'] != item['token']
            or row['paragraph_index'] != p or row['start'] != start or row['end'] != end
            or row['sentence'] != item['sentence'] or row['sense_key'] != item['sense_key']):
        return None
    if row['head_id'] is None:
        return 0, 'DRAFT'  # Seed occurrence.status is not an effective approval.
    version, payload = row['head_version'], row['head_payload']
    if (type(version) is not int or not 0 <= version <= MAX_SAFE_INTEGER or not isinstance(payload, dict)
            or type(payload.get('version')) is not int or payload['version'] != version
            or payload.get('status') not in ('DRAFT', 'APPROVED')):
        return None
    return version, payload['status']


def evidence_candidates(db: Session, document: str | None = None, token: str | None = None) -> dict:
    if document is not None:
        if not isinstance(document, str):
            raise HTTPException(422, detail={'code': 'EVIDENCE_CANDIDATES_INVALID_REQUEST'})
        try:
            # Reject alternate UUID spellings rather than silently changing a filter.
            if str(UUID(document)) != document:
                raise ValueError('noncanonical')
        except ValueError:
            raise HTTPException(422, detail={'code': 'EVIDENCE_CANDIDATES_INVALID_REQUEST'}) from None
    if token is not None and (not isinstance(token, str) or token not in TOKENS):
        raise HTTPException(422, detail={'code': 'EVIDENCE_CANDIDATES_INVALID_REQUEST'})
    items = [item for item in evidence_catalog() if (document is None or item['document_id'] == document)
             and (token is None or item['token'] == token)]
    corpus = current_corpus()
    occurrence, head, doc = KnowledgeOccurrence, AnnotationHead, ReadingDocument
    query = select(
        occurrence.id, occurrence.document_id, occurrence.occurrence_key, occurrence.kind,
        occurrence.surface, occurrence.paragraph_index, occurrence.start, occurrence.end,
        occurrence.sentence, occurrence.sense_key,
        doc.source.label('document_source'), doc.corpus_hash.label('document_hash'), doc.context.label('document_context'),
        head.annotation_id.label('head_id'), head.version.label('head_version'), head.payload.label('head_payload'),
    ).join(doc, doc.id == occurrence.document_id).outerjoin(head, head.annotation_id == occurrence.id)\
     .where(occurrence.id.in_([item['annotation_id'] for item in items])).limit(16)
    with db.no_autoflush:
        rows = {row['id']: row for row in db.execute(query).mappings()}
    for item in items:
        binding = _valid_binding(item, corpus.get(item['source']), rows.get(item['annotation_id']))
        item.update(availability='AVAILABLE' if binding is not None else 'UNAVAILABLE',
                    annotation_version=binding[0] if binding is not None else None,
                    annotation_status=binding[1] if binding is not None else None)
    available = sum(item['availability'] == 'AVAILABLE' for item in items)
    return {'version': VERSION, 'batch_id': BATCH_ID,
            'summary': {'targets': len({item['token'] for item in items}), 'candidates': len(items),
                        'available': available, 'unavailable': len(items) - available, 'original_context': len(items),
                        'interpretation_sources': 0, 'applied': 0}, 'items': items}
