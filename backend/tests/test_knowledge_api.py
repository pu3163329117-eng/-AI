"""Real SQL rows and read-only API tests, isolated from learners' local data."""
from __future__ import annotations

from copy import deepcopy
from unicodedata import category

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.db.models import KnowledgeOccurrence, ReadingDocument, TrainingEvent, TrainingSession
from backend.db.session import Base, get_db
from backend.db.knowledge import document_id, knowledge_coverage, knowledge_lookup, seed_knowledge
import backend.db.knowledge as store
from backend.domain.knowledge import locate_annotation, selection_for
from backend.main import app


def _context(text: str, version: str = "v1") -> dict:
    return {"paragraphs": [text], "full_text": text, "author": "测试作者", "era": "原创测试", "work_note": "非教学材料", "extent": "CHAPTER", "text_version": version, "source_url": "https://example.org/source", "terms": ["学者"]}


def _annotation(source: str, anchor: str, token: str, sense_key: str, meaning: str, variability: str = "CONTEXTUAL", **extra) -> dict:
    return {"source": source, "paragraph_index": 0, "anchor": anchor, "token": token, "sense_key": sense_key, "meaning": meaning, "part_of_speech": "动词" if token == "从" else "名词", "variability": variability, "reasoning": "本句根据人物动作关系推断，不表示学生是否学过。", **extra}


@pytest.fixture
def corpus_db(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    corpus = {"《甲》": _context("𠀀学者学于师。学者从师；从之而学。"), "《乙》": _context("弟子从师而学。此行从城而来。"), "《丙》": _context("学者从师。")}
    annotations = [
        _annotation("《甲》", "𠀀学者", "学者", "learner", "求学的人", "STABLE"),
        _annotation("《甲》", "学者从师", "从", "follow_learn", "跟随学习"),
        _annotation("《甲》", "从之而学", "从", "follow_learn", "跟随学习"),
        _annotation("《乙》", "弟子从师", "从", "follow_learn", "跟随学习"),
        _annotation("《乙》", "此行从城而来", "从", "origin", "来自"),
        _annotation("《丙》", "学者从师", "从", "follow_learn", "跟随学习"),
    ]
    monkeypatch.setattr(store, "current_corpus", lambda: corpus)
    db = Session(engine)
    seed_knowledge(db, annotations, corpus)
    db.commit()
    def dependency():
        yield db
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = dependency
    client = TestClient(app)  # No global startup or persistent test DB mutation.
    yield db, client, corpus, annotations
    client.close()
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    db.close()
    engine.dispose()


def _session(db, source, context):
    snapshot = {"source": source, "stage": "CORE", "reading_context": deepcopy(context), "state_version": 7, "deferred_variable": False, "completed": False, "feedback": None}
    record = TrainingSession(state_version=7, snapshot=snapshot)
    db.add(record)
    db.commit()
    return record


def _lookup(client, record, start, end, **extra):
    return client.get("/api/knowledge/lookup", params={"session_id": record.id, "paragraph_index": 0, "start": start, "end": end, **extra})


def test_unicode_compound_word_and_read_only_session(corpus_db):
    db, client, corpus, annotations = corpus_db
    record = _session(db, "《甲》", corpus["《甲》"])
    before = deepcopy(record.snapshot)
    event_count = db.scalar(select(func.count()).select_from(TrainingEvent))
    # 𠀀 is one codepoint; clicking the inner 者 at index 2 finds 学者.
    response = _lookup(client, record, 2, 3)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ANNOTATED"
    assert body["selection"]["token"] == "者"
    assert body["selection"]["sentence"] == "𠀀学者学于师。"
    assert body["annotations"][0]["token"] == "学者"
    assert body["annotations"][0]["start"] == 1
    assert body["annotations"][0]["variability"] == "STABLE"
    assert body["annotations"][0]["status"] == "DRAFT"
    assert db.scalar(select(func.count()).select_from(TrainingEvent)) == event_count
    db.refresh(record)
    assert record.snapshot == before and record.state_version == 7


def test_contextual_senses_exact_positions_and_related_pagination(corpus_db):
    db, client, corpus, annotations = corpus_db
    record = _session(db, "《乙》", corpus["《乙》"])
    first = locate_annotation(corpus["《乙》"], annotations[3])
    second = locate_annotation(corpus["《乙》"], annotations[4])
    body = _lookup(client, record, first["start"], first["end"], limit=1).json()
    assert body["annotations"][0]["meaning"] == "跟随学习"
    assert body["related"]["total"] == 4
    assert body["related"]["items"][0]["relation"] == "SAME_SENSE"
    pages = [_lookup(client, record, first["start"], first["end"], offset=index, limit=1).json()["related"]["items"][0] for index in range(4)]
    assert [row["relation"] for row in pages] == ["SAME_SENSE"] * 3 + ["OTHER_SENSE"]
    assert pages[-1]["source"] == "《乙》" and pages[-1]["meaning"] == "来自"
    for item in pages:
        assert corpus[item["source"]]["paragraphs"][item["paragraph_index"]][item["start"]:item["end"]] == item["token"]
        assert item["sentence"] and item["source_url"]
    assert _lookup(client, record, second["start"], second["end"]).json()["annotations"][0]["sense_key"] == "origin"
    assert _lookup(client, record, first["start"], first["end"], offset=100).json()["related"]["items"] == []


@pytest.mark.parametrize("start,end,extra", [(2, 2, {}), (8, 99, {}), (0, 1, {"paragraph_index": 9}), (-1, 1, {}), (0, 1, {"offset": -1}), (0, 1, {"limit": 0}), (0, 1, {"limit": 26}), (6, 7, {})])
def test_invalid_selection_and_paging_are_rejected(corpus_db, start, end, extra):
    db, client, corpus, _ = corpus_db
    record = _session(db, "《甲》", corpus["《甲》"])
    assert _lookup(client, record, start, end, **extra).status_code == 422
    assert record.state_version == 7


def test_pending_and_missing_session(corpus_db):
    db, client, corpus, _ = corpus_db
    record = _session(db, "《甲》", corpus["《甲》"])
    body = _lookup(client, record, 0, 1).json()
    assert body["status"] == "PENDING" and body["annotations"] == []
    assert body["document"]["indexed_positions"] > body["document"]["annotated_positions"]
    assert client.get("/api/knowledge/lookup", params={"session_id": "not-found", "paragraph_index": 0, "start": 0, "end": 1}).status_code == 404


def test_lookup_uses_current_transfer_not_the_frozen_core(corpus_db):
    db, client, corpus, annotations = corpus_db
    record = _session(db, "《乙》", corpus["《乙》"])
    record.snapshot = {**record.snapshot, "stage": "TRANSFER", "frozen_content": {"source": "《甲》", "reading_context": corpus["《甲》"]}}
    db.commit()
    selected = locate_annotation(corpus["《乙》"], annotations[4])
    body = _lookup(client, record, selected["start"], selected["end"]).json()
    assert body["document"]["source"] == "《乙》"
    assert body["selection"]["sentence"] == "此行从城而来。"
    assert body["annotations"][0]["meaning"] == "来自"
    assert record.snapshot["stage"] == "TRANSFER"


def test_coverage_counts_characters_not_annotated_words(corpus_db):
    db, client, corpus, annotations = corpus_db
    body = client.get("/api/knowledge/coverage").json()
    assert body["totals"]["documents"] == 3
    assert body["totals"]["indexed_positions"] == sum(category(char)[0] in "LN" for context in corpus.values() for p in context["paragraphs"] for char in p)
    assert body["totals"]["codepoint_positions"] == sum(len(p) for context in corpus.values() for p in context["paragraphs"])
    assert body["totals"]["annotations"] == 6
    assert body["totals"]["annotated_positions"] == 7  # one 2-character compound plus five singletons
    assert db.scalar(select(func.count()).select_from(KnowledgeOccurrence).where(KnowledgeOccurrence.kind == "POSITION")) == body["totals"]["codepoint_positions"]


def test_versioned_corpus_preserves_old_offsets_and_manual_rows(corpus_db):
    db, client, corpus, annotations = corpus_db
    old_context = deepcopy(corpus["《甲》"])
    record = _session(db, "《甲》", old_context)
    doc_id = document_id("《甲》", old_context)
    row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.document_id == doc_id, KnowledgeOccurrence.surface == "学者", KnowledgeOccurrence.kind == "ANNOTATION"))
    row.meaning = "教研手工保存的解释"
    db.commit()
    seed_knowledge(db, annotations, corpus)
    db.commit()
    db.refresh(row)
    assert row.meaning == "教研手工保存的解释"
    corpus["《甲》"] = _context("新增句。" + old_context["paragraphs"][0], "v2")
    seed_knowledge(db, annotations, corpus)
    db.commit()
    assert db.scalar(select(func.count()).select_from(ReadingDocument)) == 4
    body = _lookup(client, record, 2, 3).json()
    assert body["document"]["id"] == doc_id and body["annotations"][0]["start"] == 1
    assert body["annotations"][0]["meaning"] == "教研手工保存的解释"
    unknown = _session(db, "《甲》", _context("未曾入库的历史版本。", "v0"))
    assert _lookup(client, unknown, 0, 1).json()["status"] == "UNAVAILABLE"
    missing_context = _session(db, "《甲》", old_context)
    missing_context.snapshot = {"source": "《甲》", "stage": "CORE"}
    db.commit()
    assert _lookup(client, missing_context, 0, 1).json()["status"] == "UNAVAILABLE"


def test_bad_annotation_fails_before_insert_and_exact_repeated_anchor(corpus_db):
    db, _, corpus, annotations = corpus_db
    before = db.scalar(select(func.count()).select_from(ReadingDocument))
    bad = {**annotations[0], "anchor": "不存在的原文"}
    with pytest.raises(ValueError, match="not found"):
        seed_knowledge(db, [bad], {"《甲》": _context("新版本原文。", "v99")})
    assert db.scalar(select(func.count()).select_from(ReadingDocument)) == before
    with pytest.raises(ValueError, match="duplicate"):
        seed_knowledge(db, [annotations[0], annotations[0]], corpus)
    repeated = _context("从从；从从。")
    annotation = _annotation("《甲》", "从从", "从", "follow_learn", "跟随", anchor_occurrence=1, token_occurrence=1)
    located = locate_annotation(repeated, annotation)
    assert (located["start"], located["end"], located["sentence"]) == (4, 5, "从从；从从。")
    with pytest.raises(ValueError):
        selection_for(repeated, False, 0, 1)


def test_canonical_corpus_all_thirteen_sources_exact_draft_coverage():
    from backend.domain.knowledge_annotations import ANNOTATIONS
    from backend.domain.knowledge import sentence_for
    corpus = store.current_corpus()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        seed_knowledge(db)
        db.commit()
        body = knowledge_coverage(db)
        assert len(corpus) == body["totals"]["documents"] == 13
        assert {item["source"] for item in body["documents"]} == set(corpus)
        assert body["totals"]["indexed_positions"] == sum(category(char)[0] in "LN" for context in corpus.values() for paragraph in context["paragraphs"] for char in paragraph)
        assert body["totals"]["codepoint_positions"] == sum(len(paragraph) for context in corpus.values() for paragraph in context["paragraphs"])
        assert body["totals"]["annotations"] == len(ANNOTATIONS)
        expected_covered = set()
        for annotation in ANNOTATIONS:
            located = locate_annotation(corpus[annotation["source"]], annotation)
            paragraph = corpus[annotation["source"]]["paragraphs"][located["paragraph_index"]]
            expected_covered.update((annotation["source"], located["paragraph_index"], index) for index in range(located["start"], located["end"]) if category(paragraph[index])[0] in "LN")
        assert body["totals"]["annotated_positions"] == len(expected_covered)
        assert all(item["total_annotations"] > 0 for item in body["documents"])
        documents = {row.id: row for row in db.scalars(select(ReadingDocument)).all()}
        for row in db.scalars(select(KnowledgeOccurrence)).all():
            paragraph = documents[row.document_id].context["paragraphs"][row.paragraph_index]
            assert paragraph[row.start:row.end] == row.surface
            assert sentence_for(paragraph, row.start, row.end) == row.sentence
            assert row.status == "DRAFT"
        before = db.scalar(select(func.count()).select_from(KnowledgeOccurrence))
        seed_knowledge(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(KnowledgeOccurrence)) == before
    engine.dispose()


def test_current_corpus_has_no_unannotated_body_positions():
    from backend.scripts.knowledge_audit import audit
    result = audit()
    assert result["totals"]["documents"] == 13
    assert result["totals"]["indexed_positions"] == 4362
    assert result["totals"]["annotated_positions"] == 4362
    assert result["totals"]["missing_positions"] == 0
    assert all(not item["missing"] for item in result["documents"])


def test_pronunciation_withdrawal_preserves_manual_draft_revision():
    from backend.domain.knowledge_annotations import ANNOTATIONS
    corpus = store.current_corpus()
    source = "《宋史·范仲淹传》"
    pronunciation = next(a for a in ANNOTATIONS if a["source"] == source and a["sense_key"] == "name.zhu_yue")
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        seed_knowledge(db, [pronunciation], {source: corpus[source]})
        row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.kind == "ANNOTATION"))
        row.meaning = "改名后的名，读 yuè。"
        db.commit()
        seed_knowledge(db, [pronunciation], {source: corpus[source]})
        assert "读音待教材核对" in row.meaning
        row.meaning = "改名后的名，读 yuè。"
        row.reasoning = "实际编辑者另存了依据，不能被种子脚本覆盖。"
        db.commit()
        seed_knowledge(db, [pronunciation], {source: corpus[source]})
        assert row.meaning == "改名后的名，读 yuè。"
        assert row.reasoning == "实际编辑者另存了依据，不能被种子脚本覆盖。"
        row.reasoning = pronunciation["reasoning"]
        row.sentence = "实际编辑者修改了所在句，也必须保留。"
        db.commit()
        seed_knowledge(db, [pronunciation], {source: corpus[source]})
        assert row.meaning == "改名后的名，读 yuè。"
        assert row.sentence == "实际编辑者修改了所在句，也必须保留。"
    engine.dispose()
