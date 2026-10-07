"""Review workflow operates on isolated SQLite, never real teacher attribution."""
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.db.models import AnnotationRevision, KnowledgeOccurrence
from backend.db.session import Base, get_db
from backend.db.knowledge import knowledge_coverage, knowledge_lookup, seed_knowledge
import backend.db.knowledge as knowledge_store
import backend.knowledge_routes as routes
from backend.main import app


@pytest.fixture
def review_db(monkeypatch):
    engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    context = {'paragraphs': ['𠀀从师学。'], 'full_text': '𠀀从师学。', 'author': '测试', 'era': '测试',
               'work_note': '非教研认证', 'text_version': 'test-v1', 'source_url': 'https://example.org/text', 'extent': 'CHAPTER'}
    corpus = {'测试原文': context}
    annotations = [{'source': '测试原文', 'paragraph_index': 0, 'anchor': '𠀀从师学', 'token': '从',
        'sense_key': 'test.follow', 'meaning': '跟随', 'part_of_speech': '动词', 'variability': 'CONTEXTUAL',
        'reasoning': '测试语境说明'}]
    monkeypatch.setattr(knowledge_store, 'current_corpus', lambda: corpus)
    monkeypatch.setattr(routes, 'current_corpus', lambda: corpus)
    db = Session(engine)
    seed_knowledge(db, annotations, corpus); db.commit()
    row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.kind == 'ANNOTATION'))
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, raise_server_exceptions=True)  # No lifespan/global DB.
    yield db, client, row, context, corpus, annotations
    client.close()
    app.dependency_overrides.pop(get_db, None)
    db.close(); engine.dispose()


def _edit(current, **changes):
    return {'expected_version': current['version'], 'actor': '隔离测试审核人', 'note': '仅测试工作流，不代表真实教研审核',
            **{key: current[key] for key in ['meaning', 'part_of_speech', 'variability', 'reasoning', 'source_url', 'citation']}, **changes}


def test_edit_review_revision_invalidation_and_effective_lookup(review_db):
    db, client, row, context, corpus, annotations = review_db
    url = f'/api/v1/admin/knowledge/annotations/{row.id}'
    initial = client.get(url).json()['annotation']
    assert initial['version'] == 0 and initial['status'] == 'DRAFT'
    rejected = client.post(url + '/review', json={'expected_version': 0, 'actor': '隔离测试', 'note': '测试'})
    assert rejected.status_code == 422 and rejected.json()['error']['code'] == 'ANNOTATION_SOURCE_REQUIRED'
    edited = client.patch(url, json=_edit(initial, meaning='跟从老师学习', citation='测试注本第 1 页')).json()['annotation']
    assert edited['version'] == 1 and edited['status'] == 'DRAFT'
    approved = client.post(url + '/review', json={'expected_version': 1, 'actor': '隔离测试', 'note': '测试审核'}).json()['annotation']
    assert approved['version'] == 2 and approved['status'] == 'APPROVED'
    assert knowledge_coverage(db)['totals']['approved_annotations'] == 1
    lookup = knowledge_lookup(db, {'source': '测试原文', 'reading_context': context}, 0, 1, 2)
    assert lookup['annotations'][0]['meaning'] == '跟从老师学习'
    assert lookup['annotations'][0]['reviewer'] == '隔离测试'
    old_revision = deepcopy(client.get(url).json()['history'][0])
    changed = client.patch(url, json=_edit(approved, meaning='跟随老师')).json()['annotation']
    assert changed['version'] == 3 and changed['status'] == 'DRAFT' and changed['reviewer'] is None
    assert knowledge_coverage(db)['totals']['approved_annotations'] == 0
    assert client.get(url).json()['history'][1] == old_revision
    assert row.meaning == '跟随'  # Seed is immutable, revisions are a separate layer.
    seed_knowledge(db, annotations, corpus); db.commit()
    assert client.get(url).json()['annotation']['meaning'] == '跟随老师'


def test_stale_versions_noops_and_queue_filters(review_db):
    db, client, row, *_ = review_db
    url = f'/api/v1/admin/knowledge/annotations/{row.id}'
    initial = client.get(url).json()['annotation']
    assert client.patch(url, json=_edit(initial)).json()['annotation']['version'] == 0
    assert db.scalar(select(func.count()).select_from(AnnotationRevision)) == 0
    assert client.patch(url, json=_edit(initial, citation='测试依据')).status_code == 200
    conflict = client.patch(url, json=_edit(initial, meaning='旧页面修改'))
    assert conflict.status_code == 409
    assert client.post(url + '/review', json={'expected_version': 0, 'actor': '测试', 'note': '测试'}).status_code == 409
    assert db.scalar(select(func.count()).select_from(AnnotationRevision)) == 1
    listed = client.get('/api/v1/admin/knowledge/annotations', params={'document': row.document_id, 'status': 'DRAFT', 'q': '从'})
    assert listed.json()['total'] == 1
    assert client.get('/api/v1/admin/knowledge/annotations', params={'document': row.document_id, 'status': 'APPROVED'}).json()['total'] == 0
    assert client.get('/api/v1/admin/knowledge/annotations', params={'document': row.document_id, 'q': '%'}).json()['total'] == 0


@pytest.mark.parametrize('changes', [{'meaning': '   '}, {'actor': ' '}, {'note': ' '}, {'expected_version': True},
    {'variability': 'UNKNOWN'}, {'source_url': 'javascript:alert(1)'}, {'source_url': 'https://user:secret@example.org'}])
def test_invalid_edits_do_not_create_versions(review_db, changes):
    db, client, row, *_ = review_db
    url = f'/api/v1/admin/knowledge/annotations/{row.id}'
    initial = client.get(url).json()['annotation']
    assert client.patch(url, json=_edit(initial, **changes)).status_code == 422
    assert db.scalar(select(func.count()).select_from(AnnotationRevision)) == 0


def test_position_rows_cannot_be_reviewed(review_db):
    db, client, *_ = review_db
    position = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.kind == 'POSITION'))
    assert client.get(f'/api/v1/admin/knowledge/annotations/{position.id}').status_code == 404
