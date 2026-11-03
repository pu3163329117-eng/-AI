"""Synthetic editorial gap intersections; no lifespan or real configuration."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import backend.access as access
import backend.db.annotation_queue as queue
import backend.db.annotation_quality as quality
import backend.knowledge_routes as routes
from backend.db.annotation_review import baseline, detail
from backend.db.knowledge import document_id
from backend.db.models import AnnotationHead, AnnotationRevision, KnowledgeOccurrence, ReadingDocument
from backend.db.session import Base, get_db
from backend.main import app


def _seed(db):
    context = {"paragraphs": ["从𠀀从师%_\\。"], "source_url": "https://example.org/synthetic", "text_version": "v1"}
    corpus = {"合成甲": context, "合成乙": {**context, "source_url": "", "text_version": "v2"},
              "未入库": {**context, "text_version": "not-in-database"}}
    documents = {}
    for source, value in list(corpus.items())[:2]:
        doc_id = document_id(source, value)
        documents[source] = ReadingDocument(id=doc_id, source=source, context=value, corpus_hash=doc_id)
        db.add(documents[source])
    old = {**context, "text_version": "historical"}
    old_id = document_id("合成甲", old)
    documents["old"] = ReadingDocument(id=old_id, source="合成甲", context=old, corpus_hash=old_id)
    db.add(documents["old"])
    db.flush()
    rows = {}
    for index, (name, token, source, kind) in enumerate([
        ("seed", "从", "合成甲", "ANNOTATION"), ("both", "𠀀", "合成甲", "ANNOTATION"),
        ("complete", "从", "合成甲", "ANNOTATION"), ("url", "师", "合成甲", "ANNOTATION"),
        ("citation", "%_\\", "合成甲", "ANNOTATION"), ("position", "从", "合成甲", "POSITION"),
        ("historical", "从", "old", "ANNOTATION"), ("second", "从", "合成乙", "ANNOTATION"),
    ]):
        row = KnowledgeOccurrence(id=name, document_id=documents[source].id, occurrence_key=name,
            kind=kind, paragraph_index=0, start=index, end=index + 1, surface=token, sentence="合成语境",
            sense_key="synthetic", meaning="原始 " + name, part_of_speech="动词", variability="CONTEXTUAL",
            reasoning="合成说明", status="APPROVED")
        db.add(row)
        rows[name] = row
    db.flush()
    for name, status, citation, url in [
        ("both", "DRAFT", "\t\u3000\xa0", "\n\u3000"),
        ("complete", "APPROVED", "合成依据", "https://example.org/head"),
        ("url", "DRAFT", "合成依据", ""),
        ("citation", "APPROVED", "", "https://example.org/head"),
    ]:
        payload = {**baseline(rows[name], documents["合成甲"]), "version": 1, "status": status,
                   "citation": citation, "source_url": url, "meaning": "修订 " + name,
                   "reviewer": "合成署名" if status == "APPROVED" else None}
        db.add(AnnotationHead(annotation_id=name, version=1, payload=payload))
    db.add(AnnotationRevision(annotation_id="seed", version=1, action="REVIEW",
        payload={"citation": "历史不能填当前空缺", "source_url": "https://example.org/history", "status": "APPROVED"},
        actor="合成历史", note="历史保留"))
    db.commit()
    return corpus, documents, rows


@pytest.fixture
def gaps_db(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    corpus, documents, rows = _seed(db)
    for module in (queue, quality, routes):
        monkeypatch.setattr(module, "current_corpus", lambda: corpus)
    yield SimpleNamespace(db=db, engine=engine, corpus=corpus, documents=documents, rows=rows)
    db.close()
    engine.dispose()


def _read(f, **params):
    return queue.annotation_queue(f.db, f.documents["合成甲"].id, **params)


def test_default_all_preserves_managed_annotation_payload_and_order(gaps_db):
    f = gaps_db
    result = _read(f)
    expected = [detail(f.db, f.rows[name]) for name in ("seed", "both", "complete", "url", "citation")]
    assert result == {"total": 5, "items": expected}
    assert _read(f, gap="ALL") == result
    assert result["items"][0]["status"] == "DRAFT"  # Seed is not a signed head.


@pytest.mark.parametrize("gap,expected", [("ALL", ["seed", "both", "complete", "url", "citation"]),
    ("MISSING_CITATION", ["seed", "both", "citation"]), ("MISSING_SOURCE_URL", ["both", "url"]),
    ("MISSING_EITHER", ["seed", "both", "url", "citation"])])
def test_gap_sets_and_quality_counts_agree_without_double_counting(gaps_db, gap, expected):
    result = _read(gaps_db, gap=gap)
    assert result["total"] == len(expected) and [item["id"] for item in result["items"]] == expected
    overview = quality.annotation_quality(gaps_db.db)
    document = next(item for item in overview["documents"] if item["id"] == gaps_db.documents["合成甲"].id)
    if gap in {"MISSING_CITATION", "MISSING_SOURCE_URL"}:
        assert result["total"] == document[gap.lower()]
    if gap == "MISSING_EITHER":
        assert result["total"] < document["missing_citation"] + document["missing_source_url"]


@pytest.mark.parametrize("params,expected", [
    ({"status": "DRAFT", "gap": "MISSING_CITATION"}, ["seed", "both"]),
    ({"status": "APPROVED", "gap": "MISSING_EITHER"}, ["citation"]),
    ({"status": "APPROVED", "q": "从", "gap": "MISSING_CITATION"}, []),
    ({"q": " 从 ", "gap": "MISSING_EITHER"}, ["seed"]),
    ({"q": "𠀀", "gap": "MISSING_EITHER"}, ["both"]),
    ({"q": "%", "gap": "MISSING_CITATION"}, ["citation"]),
    ({"q": "_", "gap": "ALL"}, ["citation"]),
    ({"q": "\\", "gap": "ALL"}, ["citation"]),
])
def test_filters_intersect_and_like_metacharacters_are_literal(gaps_db, params, expected):
    result = _read(gaps_db, **params)
    assert result["total"] == len(expected) and [item["id"] for item in result["items"]] == expected


@pytest.mark.parametrize("value", [None, "", " ", "\t\n\r\v\f", "\xa0\u3000\u2002\u2029", queue._WHITESPACE])
def test_head_blank_overrides_seed_and_uses_python_strip_whitespace(gaps_db, value):
    f = gaps_db
    head = f.db.get(AnnotationHead, "complete")
    head.payload = {**head.payload, "citation": value, "source_url": value}
    f.db.commit()
    for gap in ("MISSING_CITATION", "MISSING_SOURCE_URL", "MISSING_EITHER"):
        result = _read(f, gap=gap)
        item = next(item for item in result["items"] if item["id"] == "complete")
        assert item["source_url"] == value and item["citation"] == value
    assert set(queue._WHITESPACE) == {chr(code) for code in range(0x110000) if chr(code).isspace()}


def test_missing_head_fields_remain_missing_not_seed_or_history(gaps_db):
    f = gaps_db
    head = f.db.get(AnnotationHead, "complete")
    value = {**head.payload}
    value.pop("source_url")
    value.pop("citation")
    head.payload = value
    f.db.commit()
    result = _read(f, gap="MISSING_EITHER")
    item = next(item for item in result["items"] if item["id"] == "complete")
    assert "source_url" not in item and "citation" not in item
    assert next(item for item in result["items"] if item["id"] == "seed")["citation"] == ""


@pytest.mark.parametrize("has_key", [False, True])
def test_seed_absent_url_and_explicit_null_keep_original_default_payload(gaps_db, has_key):
    f = gaps_db
    source = "未补全链接材料"
    context = {"paragraphs": ["从。"], "text_version": "gap-test"}
    if has_key:
        context["source_url"] = None
    f.corpus[source] = context
    doc_id = document_id(source, context)
    f.db.add(ReadingDocument(id=doc_id, source=source, context=context, corpus_hash=doc_id))
    row = KnowledgeOccurrence(id="legacy-url", document_id=doc_id, occurrence_key="legacy-url", kind="ANNOTATION",
        paragraph_index=0, start=0, end=1, surface="从", sentence="从。", sense_key=None,
        meaning="合成", part_of_speech="动词", variability="STABLE", reasoning="合成")
    f.db.add(row)
    f.db.commit()
    expected = detail(f.db, row)
    for gap in ("ALL", "MISSING_SOURCE_URL", "MISSING_EITHER"):
        result = queue.annotation_queue(f.db, doc_id, gap=gap)
        assert result == {"total": 1, "items": [expected]}
    assert expected["source_url"] == (None if has_key else "")
    assert expected["sense_key"] is None  # Preserve legacy data; do not manufacture a key.


def test_empty_corpus_never_seeds_documents(gaps_db, monkeypatch):
    monkeypatch.setattr(queue, "current_corpus", lambda: {})
    assert _read(gaps_db) == {"total": 0, "items": []}
    assert not gaps_db.db.new and not gaps_db.db.dirty


@pytest.mark.parametrize("offset,limit,ids", [(0, 1, ["seed"]), (1, 2, ["both", "url"]),
    (3, 50, ["citation"]), (4, 5, []), (queue.MAX_SAFE_INTEGER, 50, [])])
def test_gap_pagination_uses_filtered_total_and_stable_order(gaps_db, offset, limit, ids):
    result = _read(gaps_db, gap="MISSING_EITHER", offset=offset, limit=limit)
    assert result == _read(gaps_db, gap="MISSING_EITHER", offset=offset, limit=limit)
    assert result["total"] == 4 and [item["id"] for item in result["items"]] == ids


def test_history_position_and_unknown_document_cannot_enter_queue(gaps_db):
    f = gaps_db
    assert _read(f)["total"] == 5
    for document in ("missing", f.documents["old"].id, document_id("未入库", f.corpus["未入库"])):
        assert queue.annotation_queue(f.db, document, gap="MISSING_EITHER") == {"total": 0, "items": []}
    f.corpus["合成甲"]["text_version"] = "replaced-current"
    assert _read(f) == {"total": 0, "items": []}


def test_single_read_no_autoflush_or_commits(gaps_db):
    f = gaps_db
    doc_id = f.documents["合成甲"].id  # Resolve expired fixture metadata before instrumentation.
    statements = []
    event.listen(f.engine, "before_cursor_execute", lambda conn, cursor, sql, *args: statements.append(sql))
    pending = AnnotationRevision(annotation_id="seed", version=99, action="EDIT", payload={}, actor="pending", note="not persisted")
    f.db.add(pending)
    assert queue.annotation_queue(f.db, doc_id, gap="MISSING_EITHER")["total"] == 4
    assert len(statements) == 1 and statements[0].lstrip().upper().startswith("WITH")
    assert list(f.db.new) == [pending] and f.db.in_transaction()
    f.db.rollback()
    assert not f.db.scalar(select(AnnotationRevision).where(AnnotationRevision.version == 99))


@pytest.fixture
def client(gaps_db, monkeypatch):
    settings = SimpleNamespace(mode="local", admin_enabled=True, allowed_origins=("http://testserver",), production=False)
    monkeypatch.setattr(access, "load_access_settings", lambda: settings)
    identity = SimpleNamespace(id="synthetic", role="admin")
    monkeypatch.setattr(access, "current_session", lambda *args: None if identity.id is None else (identity, SimpleNamespace()))
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: gaps_db.db
    value = TestClient(app)  # Never invoke lifespan or initialize a running DB.
    yield value, settings, identity
    value.close()
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous


@pytest.mark.parametrize("params", [{"gap": "UNKNOWN"}, {"gap": "missing_citation"}, {"status": "UNKNOWN"},
    {"offset": -1}, {"offset": 10 ** 30}, {"limit": 0}, {"limit": 51}, {"limit": "true"}, {"q": "从" * 81}])
def test_invalid_http_filters_rejected(gaps_db, client, params):
    response = client[0].get("/api/v1/admin/knowledge/annotations",
        params={"document": gaps_db.documents["合成甲"].id, **params})
    assert response.status_code == 422


@pytest.mark.parametrize("mode,enabled,role,user,expected", [("local", False, "admin", "synthetic", 404),
    ("invite", False, "admin", None, 401), ("invite", False, "admin", "synthetic", 404),
    ("invite", True, "learner", "synthetic", 403), ("invite", True, "admin", "synthetic", 200)])
def test_gap_queue_uses_existing_guard(gaps_db, client, mode, enabled, role, user, expected):
    value, settings, identity = client
    settings.mode, settings.admin_enabled = mode, enabled
    identity.role, identity.id = role, user
    response = value.get("/api/v1/admin/knowledge/annotations",
        params={"document": gaps_db.documents["合成甲"].id, "gap": "MISSING_EITHER"})
    assert response.status_code == expected and response.headers["Cache-Control"] == "no-store"


def test_http_default_and_explicit_all_are_identical(gaps_db, client):
    params = {"document": gaps_db.documents["合成甲"].id}
    first = client[0].get("/api/v1/admin/knowledge/annotations", params=params)
    second = client[0].get("/api/v1/admin/knowledge/annotations", params={**params, "gap": "ALL"})
    assert first.status_code == second.status_code == 200 and first.json() == second.json()


def test_concurrent_head_update_cannot_split_count_and_items(monkeypatch):
    output = Path(__file__).resolve().parents[2] / "output/test-runs"
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="annotation-gaps-", dir=output) as temporary:
        engine = create_engine("sqlite:///" + (Path(temporary) / "synthetic.db").as_posix())
        with engine.begin() as connection:
            connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        Base.metadata.create_all(engine)
        with Session(engine) as writer:
            corpus, documents, _ = _seed(writer)
            doc_id = documents["合成甲"].id
        monkeypatch.setattr(queue, "current_corpus", lambda: corpus)
        committed = False
        def update_between_execute_and_fetch(connection, cursor, statement, *args):
            nonlocal committed
            if committed or not statement.lstrip().upper().startswith("WITH"):
                return
            committed = True
            with Session(engine) as writer:
                head = writer.get(AnnotationHead, "both")
                head.payload = {**head.payload, "citation": "并发补全", "source_url": "https://example.org/new"}
                writer.commit()
        event.listen(engine, "after_cursor_execute", update_between_execute_and_fetch)
        with Session(engine) as reader:
            before = queue.annotation_queue(reader, doc_id, gap="MISSING_EITHER")
            assert before["total"] == len(before["items"]) == 4
            assert next(item for item in before["items"] if item["id"] == "both")["citation"].strip() == ""
        with Session(engine) as reader:
            after = queue.annotation_queue(reader, doc_id, gap="MISSING_EITHER")
            assert after["total"] == len(after["items"]) == 3
            assert "both" not in {item["id"] for item in after["items"]}
        assert committed
        engine.dispose()
