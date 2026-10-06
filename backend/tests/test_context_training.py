from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from backend.db.models import TrainingEvent  # noqa: E402
from backend.db.session import SessionLocal  # noqa: E402
from backend.domain import reading_context  # noqa: E402
from backend.domain.training import DEFAULT_LESSON_CONTENT, apply_command, initial_snapshot  # noqa: E402
from backend.main import app  # noqa: E402
from backend.tests.editorial_helpers import approve, cleanup_editorial_records, publish, verified_content  # noqa: E402, F401

pytestmark = pytest.mark.usefixtures("cleanup_editorial_records")


def _content() -> dict:
    content = deepcopy(DEFAULT_LESSON_CONTENT)
    content.update(source="《语境定位测试篇》", passage="𠮷从师学；善者从之。后有从军者。")
    content["reading_context"] = {
        "author": "测试作者", "era": "测试时代", "work_note": "完整测试原文",
        "paragraphs": [content["passage"], "学成而归。"],
    }
    content["transfer"]["reading_context"] = {
        "author": "迁移作者", "era": "迁移时代", "work_note": "迁移测试原文",
        "paragraphs": [content["transfer"]["passage"]],
    }
    return content


def _expand(snapshot: dict, **overrides: object):
    payload = {"paragraph_index": 0, "start": 1, "end": 2, "scope": "SENTENCE", **overrides}
    return apply_command(snapshot, {"type": "REQUEST_MORE_CONTEXT", "payload": payload})


def test_repeated_words_use_the_clicked_occurrence_and_unicode_codepoint_offsets():
    snapshot = initial_snapshot(_content())
    assert snapshot["context_selection"] is None

    # 𠮷 takes two UTF-16 units in a browser, but exactly one agreed codepoint.
    first = _expand(snapshot)
    assert first.snapshot["context_selection"]["token"] == "从"
    assert first.snapshot["context_selection"]["sentence"] == "𠮷从师学；善者从之。"
    assert first.snapshot["context_selection"]["paragraph"] == snapshot["passage"]

    paragraph = snapshot["reading_context"]["paragraphs"][0]
    last_start = paragraph.rindex("从")
    last = _expand(first.snapshot, start=last_start, end=last_start + 1, scope="WORD")
    assert last.snapshot["context_selection"]["sentence"] == "后有从军者。"
    astral = _expand(last.snapshot, start=0, end=1)
    assert astral.snapshot["context_selection"]["token"] == "𠮷"
    assert snapshot["context_selection"] is None


@pytest.mark.parametrize("override,code", [
    ({"paragraph_index": True}, "INVALID_CONTEXT_SELECTION"),
    ({"start": False}, "INVALID_CONTEXT_SELECTION"),
    ({"end": True}, "INVALID_CONTEXT_SELECTION"),
    ({"start": 1.0}, "INVALID_CONTEXT_SELECTION"),
    ({"start": -1}, "INVALID_CONTEXT_SELECTION"),
    ({"end": 10000}, "INVALID_CONTEXT_SELECTION"),
    ({"paragraph_index": 2}, "INVALID_CONTEXT_SELECTION"),
    ({"start": 2, "end": 2}, "INVALID_CONTEXT_SELECTION"),
    ({"start": 4, "end": 5}, "INVALID_CONTEXT_SELECTION"),
    ({"scope": "UNKNOWN"}, "INVALID_CONTEXT_SCOPE"),
    ({"scope": None}, "INVALID_CONTEXT_SCOPE"),
])
def test_invalid_context_requests_do_not_mutate_training(override: dict, code: str):
    snapshot = initial_snapshot(_content())
    before = deepcopy(snapshot)
    with pytest.raises(ValueError, match=f"^{code}$"):
        _expand(snapshot, **override)
    assert snapshot == before


@pytest.mark.parametrize("scope", ["WORD", "SENTENCE", "PARAGRAPH", "WORK", "ERA"])
def test_all_five_context_layers_leave_reasoning_for_the_learner(scope: str):
    snapshot = initial_snapshot(_content())
    expanded = _expand(snapshot, scope=scope).snapshot
    assert expanded["context_selection"]["scope"] == scope
    # Reading more context must not award evidence, give an extra hint, select
    # an answer, or finish a stage on the learner's behalf.
    for field in ("state", "selected_answer", "evidence_selected", "hint_level", "hint", "transfer_ready", "summary_ready", "completed", "feedback"):
        assert expanded[field] == snapshot[field]


def test_reference_corpus_revisions_do_not_change_a_session_transfer(monkeypatch):
    snapshot = initial_snapshot()
    original_transfer = deepcopy(reading_context.reading_context_for(DEFAULT_LESSON_CONTENT["transfer"]))
    monkeypatch.setitem(reading_context._READING_CONTEXTS, "《论语·述而》", {
        "author": "新版作者", "era": "新版时代", "work_note": "新版资料",
        "paragraphs": ["新版资料与原会话不同。"],
    })
    selected = apply_command(snapshot, {"type": "SELECT_EVIDENCE"}).snapshot
    validated = apply_command(selected, {
        "type": "SUBMIT_ATTEMPT", "payload": {"answer": selected["correct_answer"]},
    }).snapshot
    transferred = apply_command(validated, {"type": "CONTINUE_TO_TRANSFER"}).snapshot
    assert transferred["reading_context"] == original_transfer


def _start(client: TestClient, lesson_id: str = "lesson-junior-cong-01") -> dict:
    profile = client.post("/api/v1/profiles", json={
        "display_name": f"语境验收{uuid4().hex[:6]}", "school_stage": "JUNIOR",
    })
    assert profile.status_code == 201
    response = client.post("/api/v1/training/sessions", json={
        "profile_id": profile.json()["profile"]["id"], "lesson_id": lesson_id,
    })
    assert response.status_code == 201
    return response.json()


def _send(client: TestClient, session_id: str, snapshot: dict, action: str, payload: dict | None = None, key: str | None = None):
    return client.post(f"/api/v1/training/sessions/{session_id}/commands", json={
        "type": action, "expected_state_version": snapshot["state_version"], "payload": payload or {},
    }, headers={"Idempotency-Key": key or uuid4().hex})


def _events(session_id: str) -> list[tuple[str, dict]]:
    with SessionLocal() as db:
        return [(event.type, event.payload) for event in db.scalars(
            select(TrainingEvent).where(TrainingEvent.session_id == session_id).order_by(TrainingEvent.sequence_no)
        )]


def test_context_command_is_persisted_replay_safe_and_preserves_validated_answer():
    with TestClient(app) as client:
        started = _start(client)
        session_id, snapshot = started["session_id"], started["session"]
        snapshot = _send(client, session_id, snapshot, "SELECT_EVIDENCE").json()["session"]
        snapshot = _send(client, session_id, snapshot, "SUBMIT_ATTEMPT", {"answer": snapshot["correct_answer"]}).json()["session"]
        assert snapshot["state"] == "ANSWER_VALIDATED"
        context = snapshot["reading_context"]
        paragraph_index = next(index for index, paragraph in enumerate(context["paragraphs"]) if "从" in paragraph)
        start = context["paragraphs"][paragraph_index].index("从")
        payload = {"paragraph_index": paragraph_index, "start": start, "end": start + 1, "scope": "ERA"}
        key = uuid4().hex
        expanded = _send(client, session_id, snapshot, "REQUEST_MORE_CONTEXT", payload, key)
        assert expanded.status_code == 200, expanded.json()
        current = expanded.json()["session"]
        assert current["state"] == "ANSWER_VALIDATED"
        assert current["selected_answer"] == snapshot["selected_answer"]
        assert current["evidence_selected"] is True and current["transfer_ready"] is True
        assert current["context_selection"]["scope"] == "ERA"
        assert current["state_version"] == snapshot["state_version"] + 1

        replay = _send(client, session_id, snapshot, "REQUEST_MORE_CONTEXT", payload, key)
        assert replay.status_code == 200 and replay.json() == expanded.json()
        stale = _send(client, session_id, snapshot, "REQUEST_MORE_CONTEXT", payload)
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"
        restored = client.get(f"/api/v1/training/sessions/{session_id}").json()["session"]
        assert restored == current
        context_events = [event for event in _events(session_id) if event[0] == "training.context_expanded"]
        assert len(context_events) == 1
        assert context_events[0][1]["token"] == "从" and context_events[0][1]["scope"] == "ERA"
        assert context_events[0][1]["stage"] == "CORE"

        invalid = _send(client, session_id, current, "REQUEST_MORE_CONTEXT", {**payload, "start": True})
        assert invalid.status_code == 409 and invalid.json()["error"]["code"] == "INVALID_CONTEXT_SELECTION"
        assert client.get(f"/api/v1/training/sessions/{session_id}").json()["session"] == current
        assert len([event for event in _events(session_id) if event[0] == "training.context_expanded"]) == 1

        transfer = _send(client, session_id, current, "CONTINUE_TO_TRANSFER")
        assert transfer.status_code == 200
        moved = transfer.json()["session"]
        assert moved["context_selection"] is None
        assert moved["source"] == "《论语·述而》"
        assert moved["reading_context"] != context
        assert "三人行" in moved["reading_context"]["full_text"]


def test_revisiting_a_deferred_word_clears_the_pause_flag():
    snapshot = initial_snapshot(_content())
    deferred = apply_command(snapshot, {"type": "DEFER_VARIABLE"}).snapshot
    expanded = _expand(deferred).snapshot
    assert expanded["deferred"] is True
    revisited = apply_command(expanded, {"type": "REVISIT_VARIABLE"}).snapshot
    assert revisited["deferred"] is False
    assert revisited["context_selection"] == expanded["context_selection"]
    with pytest.raises(ValueError, match="^VARIABLE_NOT_DEFERRED$"):
        apply_command(revisited, {"type": "REVISIT_VARIABLE"})


def test_editorial_context_changes_only_apply_to_new_sessions():
    authored = _content()
    core = {key: value for key, value in authored.items() if key not in ("transfer", "summary")}
    content = verified_content({"CORE": core, "TRANSFER": authored["transfer"]})
    marker = uuid4().hex[:10]
    with TestClient(app) as client:
        created = client.post("/api/v1/admin/lessons", json={
            "slug": f"context-freeze-{marker}", "school_stage": "JUNIOR", "title": "全文语境验收",
            "source": core["source"], "difficulty": "基础", "estimated_minutes": 5, "summary": "全文点读验证。",
            "level_order": 9900, "textbook_tags": ["QA语境"], "theme": "QA语境",
            "accumulation_points": ["从"], "reasoning_points": ["语境定位"], "reasoning_level": "L1", "content": content,
        })
        assert created.status_code == 201, created.json()
        lesson_id = created.json()["lesson"]["id"]
        approve(client, lesson_id)
        assert publish(client, lesson_id).status_code == 200
        started = _start(client, lesson_id)
        session_id, frozen = started["session_id"], started["session"]
        changed = deepcopy(content)
        changed["CORE"]["passage"] = "新版正文从此处开始。"
        changed["CORE"]["reading_context"].update(author="新版作者", paragraphs=["新版正文从此处开始。"], text_version="test-v2")
        changed["TRANSFER"]["passage"] = "新版迁移原文从此处开始。"
        changed["TRANSFER"]["reading_context"].update(paragraphs=["新版迁移原文从此处开始。"], text_version="test-v2")
        assert client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={"content": changed}).status_code == 200

        expanded = _send(client, session_id, frozen, "REQUEST_MORE_CONTEXT", {
            "paragraph_index": 0, "start": 1, "end": 2, "scope": "WORD",
        })
        assert expanded.status_code == 200, expanded.json()
        current = expanded.json()["session"]
        assert current["context_selection"]["token"] == "从"
        assert current["reading_context"] == frozen["reading_context"]
        assert current["reading_context"]["author"] == "测试作者"
        current = _send(client, session_id, current, "SELECT_EVIDENCE").json()["session"]
        current = _send(client, session_id, current, "SUBMIT_ATTEMPT", {"answer": current["correct_answer"]}).json()["session"]
        transferred = _send(client, session_id, current, "CONTINUE_TO_TRANSFER").json()["session"]
        assert transferred["reading_context"]["paragraphs"] == authored["transfer"]["reading_context"]["paragraphs"]
        approve(client, lesson_id)
        assert publish(client, lesson_id).status_code == 200
        fresh = _start(client, lesson_id)["session"]
        assert fresh["reading_context"]["author"] == "新版作者"
        assert fresh["reading_context"]["paragraphs"] == ["新版正文从此处开始。"]


def _editorial_payload(reading: dict) -> dict:
    content = _content()
    core = {key: value for key, value in content.items() if key not in ("transfer", "summary")}
    core["reading_context"] = reading
    return {
        "slug": f"reading-data-{uuid4().hex[:10]}", "school_stage": "JUNIOR", "title": "阅读资料验收",
        "source": core["source"], "difficulty": "基础", "estimated_minutes": 5, "summary": "阅读资料校验。",
        "level_order": 9901, "textbook_tags": ["QA资料"], "theme": "QA资料",
        "accumulation_points": ["从"], "reasoning_points": ["语境定位"], "reasoning_level": "L1",
        "content": {"CORE": core, "TRANSFER": verified_content({"TRANSFER": content["transfer"]})["TRANSFER"]},
    }


@pytest.mark.parametrize("malformed", [
    {"paragraphs": "甲从乙学。"},
    {"paragraphs": ["甲从乙学。"], "extent": "EVERYTHING"},
    {"paragraphs": ["甲从乙学。"], "terms": "甲从乙"},
])
def test_editorial_rejects_malformed_reading_data_before_publication(malformed: dict):
    with TestClient(app) as client:
        payload = _editorial_payload(malformed)
        response = client.post("/api/v1/admin/lessons", json=payload)
        assert response.status_code == 422, response.json()
        assert response.json()["error"]["code"] == "LESSON_READING_CONTEXT_INVALID"
        assert response.json()["error"]["stage"] == "CORE"
        listed = client.get("/api/v1/admin/lessons").json()["lessons"]
        assert payload["slug"] not in {lesson["slug"] for lesson in listed}


def test_complete_editorial_reading_metadata_is_published_frozen_and_keeps_offsets():
    reading = {
        "paragraphs": [" 𠮷从师学；善者从之。后有从军者。 ", " 学成而归。 "],
        "extent": "FULL", "author": "测试作者", "era": "测试时代", "work_note": "测试全篇",
        "text_version": "校订版本 2026-10", "source_url": "https://example.com/reading-source",
        "terms": ["从师", "善者"],
    }
    with TestClient(app) as client:
        response = client.post("/api/v1/admin/lessons", json=_editorial_payload(reading))
        assert response.status_code == 201, response.json()
        lesson_id = response.json()["lesson"]["id"]
        approve(client, lesson_id)
        assert publish(client, lesson_id).status_code == 200
        started = _start(client, lesson_id)
        snapshot = started["session"]
        for key, value in reading.items():
            assert snapshot["reading_context"][key] == value
        assert snapshot["reading_context"]["full_text"] == "\n\n".join(reading["paragraphs"])
        expanded = _send(client, started["session_id"], snapshot, "REQUEST_MORE_CONTEXT", {
            "paragraph_index": 0, "start": 2, "end": 3, "scope": "WORD",
        })
        assert expanded.status_code == 200, expanded.json()
        assert expanded.json()["session"]["context_selection"]["token"] == "从"
        assert expanded.json()["session"]["context_selection"]["paragraph"] == reading["paragraphs"][0]
        revised = deepcopy(response.json()["lesson"]["content"])
        revised["CORE"]["reading_context"].update(
            extent="EXCERPT", text_version="下次校订", source_url="https://example.com/revised", terms=["学成"],
        )
        assert client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={"content": revised}).status_code == 200
        restored = client.get(f"/api/v1/training/sessions/{started['session_id']}").json()["session"]
        assert restored["reading_context"] == snapshot["reading_context"]


def test_yueyang_new_sessions_expose_the_complete_six_paragraph_work():
    with TestClient(app) as client:
        context = _start(client, "lesson-junior-qu-01")["session"]["reading_context"]
    assert context["extent"] == "FULL"
    assert len(context["paragraphs"]) == 6
    assert context["paragraphs"][-1] == "时六年九月十五日。"
    assert "北通巫峡，南极潇湘" in context["full_text"]
    assert "长烟一空，皓月千里" in context["full_text"]


def test_malformed_legacy_paragraph_string_falls_back_to_one_prompt_without_splitting_characters():
    content = _content()
    content["reading_context"] = {"paragraphs": "旧版错误正文", "terms": "旧版错误词表"}
    context = reading_context.reading_context_for(content)
    assert context["paragraphs"] == [content["passage"]]
    assert context["full_text"] == content["passage"]
    assert context["extent"] == "PROMPT"
    assert context["terms"] == []
