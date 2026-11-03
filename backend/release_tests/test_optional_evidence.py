"""Optional reasons and server-bound annotation evidence; synthetic data only."""
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.ai.preview import preview_input
from backend.ai.settings import AISettings
from backend import ai_routes
from backend.db.annotation_review import baseline
from backend.db.evidence_basis import resolve_annotation_basis
from backend.db.knowledge import document_id, seed_knowledge
from backend.db.models import AnnotationHead, CommandReceipt, KnowledgeOccurrence, ReadingDocument, TrainingEvent, TrainingSession
from backend.db.session import Base, get_db
from backend.domain.training import DEFAULT_LESSON_CONTENT, apply_command, initial_snapshot
from backend.domain.reading_context import reading_context_for
from backend.main import app


def content():
    result = deepcopy(DEFAULT_LESSON_CONTENT)
    for stage, item in (("CORE", result), ("TRANSFER", result["transfer"])):
        item.update(source=f"《合成{stage}》", passage="𠀀从师学。后从军。", evidence="师学",
                    variable="从", correct_answer=item["choices"][1] if stage == "CORE" else item["choices"][0])
        item["reading_context"] = {"paragraphs": [item["passage"]], "author": "合成作者", "era": "合成时代",
            "work_note": "隔离验收材料", "extent": "EXCERPT", "text_version": "synthetic-v1",
            "source_url": "https://example.org/synthetic"}
    return result


def payload(state, **changes):
    return {"paragraph_index": 0, "start": 1, "end": 4, "conclusion": state["correct_answer"], **changes}


def save(state, **changes):
    return apply_command(state, {"type": "SAVE_REASONING", "payload": payload(state, **changes)})


@pytest.mark.parametrize("reason", [None, "", " ", "对", "跟从", "跟老师学", "字" * 2000])
def test_optional_reason_accepts_empty_short_and_previous_limit(reason):
    state = initial_snapshot(content())
    before = deepcopy(state)
    saved = save(state, **({} if reason is None else {"reason": reason})).snapshot
    graph = saved["reasoning_graph"]
    assert graph["reason"] == (reason or "").strip()
    assert graph["reason_provided"] == bool((reason or "").strip())
    assert graph["reason_review_status"] == ("UNREVIEWED" if graph["reason"] else "NOT_PROVIDED")
    assert graph["basis_kind"] == "CONTEXT" and saved["evidence_selected"]
    assert not saved["transfer_ready"] and state == before
    submitted = apply_command(saved, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": graph["conclusion"]}}).snapshot
    assert submitted["transfer_ready"]
    first = submitted["learning_trace"]["stages"]["CORE"]["first_attempt"]
    assert first["reason_review_status"] == graph["reason_review_status"]
    if not graph["reason"]:
        assert "不评价文字论证能力" in submitted["feedback"]
        with pytest.raises(ValueError, match="AI_INPUT_INVALID"):
            preview_input(submitted)  # Validation occurs before any provider runtime.


@pytest.mark.parametrize("changes", [{"reason": None}, {"reason": 1}, {"reason": "字" * 2001},
    {"basis_kind": "UNKNOWN"}, {"annotation_id": "forged"}, {"meaning": "伪造"},
    {"reviewed": True}, {"resolved_annotation": {}}, {"scope": "ERA"}])
def test_invalid_payload_is_atomic(changes):
    state = initial_snapshot(content()); before = deepcopy(state)
    with pytest.raises(ValueError):
        save(state, **changes)
    assert state == before


def test_optional_reason_does_not_allow_guess_or_nonmatching_context_to_pass():
    state = initial_snapshot(content())
    attempt = apply_command(state, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": state["correct_answer"]}}).snapshot
    assert not attempt["transfer_ready"] and "选填" in attempt["feedback"]
    saved = save(state, start=6, end=8).snapshot
    assert not saved["evidence_selected"]
    assert not apply_command(saved, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": state["correct_answer"]}}).snapshot["transfer_ready"]


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("WENYAN_ACCESS_MODE", "local")
    monkeypatch.setenv("WENYAN_ENV", "test")
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    lesson = content()
    corpus = {item["source"]: reading_context_for(item) for item in (lesson, lesson["transfer"])}
    annotations = [{"source": source, "paragraph_index": 0, "anchor": "从师学", "token": "从", "sense_key": "follow",
        "meaning": "跟从老师学习（合成草稿）", "part_of_speech": "动词", "variability": "CONTEXTUAL", "reasoning": "合成原文关系"}
        for source in corpus]
    seed_knowledge(db, annotations, corpus)
    state = initial_snapshot(lesson)
    record = TrainingSession(id=str(uuid4()), state_version=1, snapshot=state)
    db.add(record); db.commit()
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, headers={'X-Wenyan-Training-Contract': 'guided-v1'})
    try:
        yield db, client, record
    finally:
        client.close()
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous
        db.close(); engine.dispose()


def annotation_payload(db, state, **changes):
    row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.document_id == document_id(state["source"], state["reading_context"]),
        KnowledgeOccurrence.kind == "ANNOTATION"))
    return payload(state, start=1, end=2, basis_kind="ANNOTATION", annotation_id=row.id, annotation_version=0, **changes)


def post(client, record, state, action, data=None, key=None):
    return client.post(f"/api/v1/training/sessions/{record.id}/commands", json={"type": action,
        "expected_state_version": state["state_version"], "payload": data or {}}, headers={"Idempotency-Key": key or str(uuid4())})


def test_annotation_sentence_is_original_evidence_and_draft_origin_is_preserved(store):
    db, client, record = store
    original = record.snapshot
    data = annotation_payload(db, original)
    response = post(client, record, original, "SAVE_REASONING", data, "once")
    assert response.status_code == 200, response.text
    saved = response.json()["session"]; graph = saved["reasoning_graph"]
    assert graph["evidence"]["token"] == "从"
    assert graph["rule_evidence"]["token"] == "𠀀从师学。"
    assert graph["rule_evidence"]["start"] == 0 and graph["rule_evidence"]["end"] == 5
    assert graph["rule_evidence"]["source_kind"] == "ANNOTATION_SENTENCE"
    assert graph["annotation"]["meaning"] == "跟从老师学习（合成草稿）"
    assert graph["annotation"]["status"] == "DRAFT" and graph["annotation"]["citation"] == ""
    assert graph["reason"] == "" and graph["reason_review_status"] == "NOT_PROVIDED"
    assert saved["evidence_selected"] and not saved["transfer_ready"]
    assert saved["learning_trace"]["stages"]["CORE"]["assistance_kinds"] == ["WORD_MEANING", "RULE_CHECK"]
    assert post(client, record, original, "SAVE_REASONING", data, "once").json() == response.json()
    assert post(client, record, original, "SAVE_REASONING", data, "stale").status_code == 409
    assert client.get(f"/api/v1/training/sessions/{record.id}").json()["session"]["reasoning_graph"] == graph
    assert len(client.get(f"/api/v1/training/sessions/{record.id}/reasoning").json()["records"]) == 1
    wrong = next(choice for choice in saved["choices"] if choice != saved["correct_answer"])
    assert not post(client, record, saved, "SUBMIT_ATTEMPT", {"answer": wrong}).json()["session"]["transfer_ready"]


@pytest.mark.parametrize("case", ["cross_document", "wrong_version", "fake", "boolean_version", "negative_version",
    "moved_selection", "raw_meaning", "fake_approved", "position_not_annotation", "changed_frozen_text", "changed_text_version"])
def test_annotation_failures_have_no_session_event_or_receipt_writes(store, case):
    db, client, record = store
    data = annotation_payload(db, record.snapshot)
    if case == "cross_document":
        data["annotation_id"] = db.scalar(select(KnowledgeOccurrence.id).where(KnowledgeOccurrence.kind == "ANNOTATION",
            KnowledgeOccurrence.id != data["annotation_id"]))
    elif case == "wrong_version": data["annotation_version"] = 1
    elif case == "fake": data["annotation_id"] = str(uuid4())
    elif case == "boolean_version": data["annotation_version"] = True
    elif case == "negative_version": data["annotation_version"] = -1
    elif case == "moved_selection": data.update(start=6, end=7)
    elif case == "raw_meaning": data["meaning"] = "师学所以正确"
    elif case == "fake_approved": data["status"] = "APPROVED"
    elif case == "position_not_annotation":
        data["annotation_id"] = db.scalar(select(KnowledgeOccurrence.id).where(KnowledgeOccurrence.kind == "POSITION"))
    else:
        state = deepcopy(record.snapshot)
        if case == "changed_text_version": state["reading_context"]["text_version"] = "v2"
        else: state["reading_context"]["paragraphs"] = ["𠀀从别师。后从军。"]
        record.snapshot = state; db.commit()
    before = deepcopy(record.snapshot)
    response = post(client, record, before, "SAVE_REASONING", data)
    assert response.status_code == 409, response.text
    db.refresh(record)
    assert record.snapshot == before and record.state_version == 1
    assert db.scalar(select(func.count()).select_from(TrainingEvent)) == 0
    assert db.scalar(select(func.count()).select_from(CommandReceipt)) == 0


def test_annotation_receipt_retains_frozen_meaning_after_live_head_changes(store):
    db, client, record = store
    initial = deepcopy(record.snapshot); data = annotation_payload(db, initial)
    first = post(client, record, initial, "SAVE_REASONING", data, "receipt").json()
    row = db.get(KnowledgeOccurrence, data["annotation_id"])
    head = baseline(row, db.get(ReadingDocument, row.document_id))
    head.update(version=1, meaning="教研新草稿", status="DRAFT")
    db.add(AnnotationHead(annotation_id=row.id, version=1, payload=head)); db.commit()
    assert post(client, record, initial, "SAVE_REASONING", data, "receipt").json() == first
    assert first["session"]["reasoning_graph"]["annotation"]["meaning"] != head["meaning"]
    stale = post(client, record, first["session"], "SAVE_REASONING", data)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "ANNOTATION_EVIDENCE_VERSION_CONFLICT"


def test_annotation_and_empty_reason_complete_two_stages_exactly_once(store):
    db, client, record = store
    state = deepcopy(record.snapshot)
    for stage in ("CORE", "TRANSFER"):
        state = post(client, record, state, "SAVE_REASONING", annotation_payload(db, state)).json()["session"]
        state = post(client, record, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}).json()["session"]
        assert "不代表独立推理" in state["feedback"]
        first = state["learning_trace"]["stages"][stage]["first_attempt"]
        assert first["reason_review_status"] == "NOT_PROVIDED" and first["assistance_status"] == "ASSISTED"
        if stage == "CORE":
            assert state["transfer_ready"]
            state = post(client, record, state, "CONTINUE_TO_TRANSFER").json()["session"]
            assert state["reasoning_graph"] is None and not state["evidence_selected"]
    before = deepcopy(state)
    complete = post(client, record, before, "COMPLETE_SESSION", key="complete")
    assert complete.json()["session"]["completed"]
    assert post(client, record, before, "COMPLETE_SESSION", key="complete").json() == complete.json()
    assert post(client, record, complete.json()["session"], "COMPLETE_SESSION").status_code == 409
    assert db.scalar(select(func.count()).select_from(TrainingEvent).where(TrainingEvent.type == "training.session_completed")) == 1
    assert len(client.get(f"/api/v1/training/sessions/{record.id}/reasoning").json()["records"]) == 2


def test_broader_selection_cannot_borrow_neighbouring_sentence_to_make_annotation_match(store):
    db, _, record = store
    row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.kind == "ANNOTATION",
        KnowledgeOccurrence.document_id == document_id(record.snapshot["source"], record.snapshot["reading_context"])))
    # Move only the synthetic annotation to the second occurrence; its meaning
    # deliberately mentions the rule but cannot supply original-text coverage.
    row.start, row.end, row.surface, row.meaning = 6, 7, "从", "师学"
    db.commit()
    data = annotation_payload(db, record.snapshot)
    data.update(start=1, end=8)
    resolved = resolve_annotation_basis(db, record.snapshot, data)
    result = apply_command(record.snapshot, {"type": "SAVE_REASONING", "payload": data}, resolved_annotation=resolved)
    assert result.snapshot["reasoning_graph"]["rule_evidence"]["token"] == "后从军。"
    assert not result.snapshot["evidence_selected"]


@pytest.mark.parametrize("terminal", ["。", "！", "？", "?", "!"])
@pytest.mark.parametrize("wide", [False, True])
def test_annotation_sentence_delimiters_do_not_borrow_previous_sentence(store, terminal, wide):
    db, client, _ = store
    lesson = content()
    text = f"从师学{terminal}后从军。"
    lesson.update(passage=text)
    lesson["reading_context"]["paragraphs"] = [text]
    state = initial_snapshot(lesson)
    context = state["reading_context"]
    seed_knowledge(db, [{"source": state["source"], "paragraph_index": 0, "anchor": "后从军", "token": "从",
        "sense_key": "second-sentence", "meaning": "师学（故意不能作为规则证据的合成释义）",
        "part_of_speech": "动词", "variability": "CONTEXTUAL", "reasoning": "仅合成测试"}], {state["source"]: context})
    record = TrainingSession(id=str(uuid4()), state_version=1, snapshot=state)
    db.add(record); db.commit()
    row = db.scalar(select(KnowledgeOccurrence).where(KnowledgeOccurrence.document_id == document_id(state["source"], context),
        KnowledgeOccurrence.kind == "ANNOTATION", KnowledgeOccurrence.sense_key == "second-sentence"))
    start, end = (0, len(text)) if wide else (5, 6)
    data = payload(state, start=start, end=end, basis_kind="ANNOTATION", annotation_id=row.id, annotation_version=0)
    response = post(client, record, state, "SAVE_REASONING", data)
    assert response.status_code == 200, response.text
    saved = response.json()["session"]
    graph = saved["reasoning_graph"]
    assert graph["rule_evidence"]["token"] == "后从军。"
    assert graph["rule_evidence"]["start"] == 4 and graph["rule_evidence"]["end"] == 8
    assert graph["rule_evidence"]["sentence"] == "后从军。"
    assert not graph["evidence_rule_matched"] and not saved["evidence_selected"]
    attempted = post(client, record, saved, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}).json()["session"]
    assert not attempted["transfer_ready"] and not attempted["summary_ready"]


def test_no_reason_ai_http_request_stops_before_runtime_and_preserves_training(store, monkeypatch):
    db, client, record = store
    state = post(client, record, record.snapshot, "SAVE_REASONING", annotation_payload(db, record.snapshot)).json()["session"]
    state = post(client, record, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}).json()["session"]
    before = deepcopy(state)
    counts = [db.scalar(select(func.count()).select_from(model)) for model in (TrainingEvent, CommandReceipt)]
    calls = []
    class NeverRuntime:
        async def run(self, *args):
            calls.append(args)
            raise AssertionError("No model/runtime call is allowed for an empty reason")
    monkeypatch.setattr(ai_routes, "load_settings", lambda: AISettings(True, "minimal_learning", "deepseek-flash", "synthetic-not-a-real-key"))
    monkeypatch.setattr(ai_routes, "runtime", NeverRuntime())
    # No context manager/lifespan: a request peer sharing the in-memory override,
    # never a launch of the working backend or its collaboration worker.
    local = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), headers={'X-Wenyan-Training-Contract': 'guided-v1'})
    try:
        response = local.post(f"/api/v1/ai/sessions/{record.id}/reason-feedback", json={
            "expected_state_version": state["state_version"], "send_minimal_data": True})
        assert response.status_code == 422 and response.json()["error"]["code"] == "AI_REASONING_REQUIRED"
        assert calls == []
        assert client.get(f"/api/v1/training/sessions/{record.id}").json()["session"] == before
        assert [db.scalar(select(func.count()).select_from(model)) for model in (TrainingEvent, CommandReceipt)] == counts
    finally:
        local.close()


def test_legacy_graph_and_untraced_session_remain_compatible():
    state = initial_snapshot(content()); state.pop("learning_trace")
    state = save(state, reason="旧版正常长理由仍可保存。").snapshot
    graph = state["reasoning_graph"]
    for key in ("basis_kind", "reason_provided"):
        graph.pop(key)
    assert apply_command(state, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": state["correct_answer"]}}).snapshot["transfer_ready"]
