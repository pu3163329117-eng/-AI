"""Assessment writes are isolated; test review attribution is never real approval."""
from copy import deepcopy
from collections import Counter
from datetime import datetime, timedelta, timezone
from random import Random

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.db.session import Base, get_db
from backend.db.models import LearnerProfile, Lesson
from backend.db.assessment_models import AssessmentQuestionRevision, AssessmentResult, AssessmentReceipt, AssessmentSession
from backend.db.assessment import seed_assessment_bank, utc_iso
from backend.domain.assessment import DIMENSIONS, LEVELS, score, valid_question, select_questions, can_assemble
from backend.domain.assessment_bank import QUESTION_BANK
from backend.domain import assessment as assessment_domain
from backend import assessment_routes as routes


def _bank():
    return [{"id": f"test-{d}-{l}-{i}", "version": 1, "dimension": d, "difficulty": l, "type": "choice",
        "stem": "仅隔离测试题，不代表教研审核", "source": f"隔离测试文本-{d}", "source_url": "https://example.org/test",
        "passage": "测试原文。", "options": [{"id": "good", "text": "测试正确项"}, {"id": "bad", "text": "测试干扰项"}],
        "answer_id": "good", "explanation": "仅用于接口隔离验证。", "tags": [], "review_status": "DRAFT",
        "reviewer": None, "reviewed_at": None} for d in DIMENSIONS for l in LEVELS for i in range(4)]


@pytest.fixture
def setup(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    db.add(LearnerProfile(id="test-profile", display_name="隔离测评", school_stage="JUNIOR", total_points=11, completed_levels=2))
    db.add(Lesson(id="test-lesson", slug="test-lesson", title="仅测试课", school_stage="JUNIOR", level_order=1,
        source="隔离测试", difficulty="旧字段", estimated_minutes=1, summary="旧数据保留"))
    questions = _bank()
    monkeypatch.setattr(routes.bank, "QUESTION_BANK", questions)
    monkeypatch.setattr(routes.bank, "BANK_VERSION", "test-v1")
    monkeypatch.setattr(routes.config, "ASSESSMENT_ENABLED", True)
    seed_assessment_bank(db, questions, "test-v1")
    db.commit()
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_db] = lambda: db

    @app.exception_handler(HTTPException)
    async def error(_request, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    client = TestClient(app)
    yield db, client, questions
    client.close()
    db.close()
    engine.dispose()


def create(client, **kwargs):
    return client.post("/api/v1/assessments", json={"profile_id": "test-profile", "mode": "PILOT", **kwargs})


def command(client, assessment, kind, payload=None, key=None, version=None):
    return client.post(f'/api/v1/assessments/{assessment["id"]}/commands', headers={"Idempotency-Key": key or f'{kind}-{assessment["state_version"]}'},
        json={"type": kind, "expected_state_version": assessment["state_version"] if version is None else version, "payload": payload or {}})


def finish(client, current, skip=False):
    for question in current["questions"]:
        response = command(client, current, "SKIP_QUESTION" if skip else "SAVE_ANSWER",
            {"question_id": question["id"], **({} if skip else {"option_id": "good"})})
        assert response.status_code == 200, response.text
        current = response.json()["assessment"]
    response = command(client, current, "COMPLETE_ASSESSMENT")
    assert response.status_code == 200, response.text
    return current, response.json()["assessment"]


def test_availability_formal_gate_and_unknown_profile(setup):
    db, client, _ = setup
    available = client.get("/api/v1/assessments/availability").json()
    assert available["pilot_available"] and not available["formal_available"]
    assert available["approved_question_count"] == 0 and available["pilot_question_count"] == 48
    assert create(client, mode="FORMAL").status_code == 409
    assert create(client, profile_id="missing").status_code == 404
    assert client.get("/api/v1/profiles/missing/assessments").status_code == 404
    assert db.scalar(select(func.count()).select_from(AssessmentSession)) == 0


def test_freeze_shuffle_restore_create_reuse_and_no_answer_leak(setup):
    db, client, questions = setup
    initial = create(client, self_level="L2", self_answers={"level": "L2", "goal": "READING", "word_strategy": "CONTEXT", "reading_experience": "GUIDED"})
    assert initial.status_code == 201
    state = initial.json()["assessment"]
    assert state["created_at"].endswith("+00:00") and state["updated_at"].endswith("+00:00")
    assert len(state["questions"]) == 24
    for d in DIMENSIONS:
        for l in LEVELS:
            assert sum(q["dimension"] == d and q["difficulty"] == l for q in state["questions"]) == 2
    assert len({q["id"] for q in state["questions"]}) == 24
    assert not any(key in str(state) for key in ["answer_id", "explanation", "reviewer", "review_status"])
    assert create(client).status_code == 200 and create(client).json()["assessment"] == state
    for question in questions:
        question["stem"] = "文件中新改的题，不应覆盖正在进行的会话"
        question["options"].reverse()
    assert client.get(f'/api/v1/assessments/{state["id"]}').json()["assessment"] == state
    q = state["questions"][0]
    saved = command(client, state, "SAVE_ANSWER", {"question_id": q["id"], "option_id": "bad", "current_index": 3}).json()["assessment"]
    assert saved["updated_at"].endswith("+00:00")
    assert saved["answers"] == {q["id"]: "bad"} and saved["current_index"] == 3
    assert client.get(f'/api/v1/assessments/{state["id"]}').json()["assessment"] == saved
    summary = client.get("/api/v1/profiles/test-profile/assessments").json()["assessments"][0]
    assert summary["answered_count"] == 1 and summary["skipped_count"] == 0 and summary["question_count"] == 24
    assert summary["self_answers"]["goal"] == "READING"
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionRevision)) == 48


def test_persisted_revision_authoritative_and_seed_never_overwrites(setup):
    db, client, questions = setup
    first = db.get(AssessmentQuestionRevision, (questions[0]["id"], "1"))
    original = deepcopy(first.payload)
    questions[0]["stem"] = "新的文件不能悄悄覆盖旧版本"
    questions[0]["review_status"] = "APPROVED"
    questions[0]["reviewer"] = "伪造文件审核人"
    seed_assessment_bank(db, questions, "test-v2"); db.commit()
    assert db.get(AssessmentQuestionRevision, (questions[0]["id"], "1")).payload == original
    assert client.get("/api/v1/assessments/availability").json()["approved_question_count"] == 0
    assert create(client, mode="FORMAL").status_code == 409


def test_command_idempotency_version_conflict_invalid_answer_and_no_grading_early(setup):
    db, client, _ = setup
    state = create(client).json()["assessment"]
    q = state["questions"][0]
    payload = {"question_id": q["id"], "option_id": "good"}
    first = command(client, state, "SAVE_ANSWER", payload, key="lost-response")
    assert first.status_code == 200
    assert command(client, state, "SAVE_ANSWER", payload, key="lost-response").json() == first.json()
    assert command(client, state, "SAVE_ANSWER", {**payload, "option_id": "bad"}, key="lost-response").status_code == 409
    assert command(client, state, "SAVE_ANSWER", payload, key="stale-tab").status_code == 409
    current = first.json()["assessment"]
    assert current["result"] is None
    assert command(client, current, "SAVE_ANSWER", {**payload, "option_id": "not-an-option"}).status_code == 422
    assert command(client, current, "SAVE_ANSWER", {"question_id": "other-paper", "option_id": "good"}).status_code == 422
    assert command(client, current, "COMPLETE_ASSESSMENT").status_code == 422
    assert db.scalar(select(func.count()).select_from(AssessmentReceipt)) == 1
    assert db.scalar(select(func.count()).select_from(AssessmentResult)) == 0


def test_pilot_completion_immutable_results_no_duplicate_no_points(setup):
    db, client, _ = setup
    initial = create(client).json()["assessment"]
    previous, completed = finish(client, initial)
    assert completed["status"] == "COMPLETED"
    assert completed["result"]["overall_score"] == 100
    assert completed["result"]["suggested_level"] is None
    assert completed["result"]["level_status"] == "PILOT_ONLY"
    assert len(completed["result"]["review"]) == 24
    assert command(client, previous, "COMPLETE_ASSESSMENT").json()["assessment"] == completed
    assert command(client, completed, "COMPLETE_ASSESSMENT", key="different-completion").status_code == 409
    assert command(client, completed, "SAVE_ANSWER", {"question_id": completed["questions"][0]["id"], "option_id": "bad"}).status_code == 409
    assert db.scalar(select(func.count()).select_from(AssessmentResult)) == 1
    profile = db.get(LearnerProfile, "test-profile")
    assert profile.total_points == 11 and profile.completed_levels == 2
    assert create(client).json()["assessment"]["id"] != initial["id"]


def test_all_skipped_null_not_zero_and_abandoned_no_answer_reveal(setup):
    db, client, _ = setup
    _, completed = finish(client, create(client).json()["assessment"], skip=True)
    result = completed["result"]
    assert result["overall_score"] is None and result["sufficiency"] == "INSUFFICIENT"
    assert all(d["score"] is None and d["skipped_count"] == 6 for d in result["dimensions"].values())
    another = create(client).json()["assessment"]
    abandoned = command(client, another, "ABANDON_ASSESSMENT").json()["assessment"]
    assert abandoned["status"] == "ABANDONED" and abandoned["result"] is None
    assert "answer_id" not in str(abandoned) and "explanation" not in str(abandoned)


def test_formal_approval_requires_each_cell_and_real_attribution(setup):
    db, client, questions = setup
    for q in questions:
        row = db.get(AssessmentQuestionRevision, (q["id"], "1"))
        row.payload = {**row.payload, "review_status": "APPROVED"}
    db.commit()
    assert not client.get("/api/v1/assessments/availability").json()["formal_available"]
    for row in db.scalars(select(AssessmentQuestionRevision)):
        row.payload = {**row.payload, "reviewer": "隔离测试，不是真实审核", "reviewed_at": "2026-10-07T00:00:00Z"}
    db.commit()
    assert client.get("/api/v1/assessments/availability").json()["formal_available"]
    created = create(client, mode="FORMAL")
    assert created.status_code == 201
    _, completed = finish(client, created.json()["assessment"])
    assert completed["result"]["suggested_level"] == "L3" and completed["result"]["level_status"] == "PROVISIONAL"


@pytest.mark.parametrize("changes", [{"expected_state_version": True}, {"expected_state_version": -1},
    {"payload": {"question_id": "x", "option_id": "good", "current_index": True}},
    {"payload": {"question_id": "x", "option_id": "good", "answer_id": "good"}},
    {"type": "COMPLETE_ASSESSMENT", "payload": {"question_id": None}},
    {"type": "SKIP_QUESTION", "payload": {"question_id": "x", "option_id": None}}])
def test_strict_command_validation(setup, changes):
    db, client, _ = setup
    state = create(client).json()["assessment"]
    response = client.post(f'/api/v1/assessments/{state["id"]}/commands', headers={"Idempotency-Key": "invalid"},
        json={"type": "SAVE_ANSWER", "expected_state_version": 0, "payload": {"question_id": "x", "option_id": "good"}, **changes})
    assert response.status_code == 422
    assert db.scalar(select(func.count()).select_from(AssessmentReceipt)) == 0


def test_missing_key_and_invalid_self_answers(setup):
    _, client, _ = setup
    assert create(client, self_answers={"score": "100"}).status_code == 422
    assert create(client, self_answers={"goal": "FAKE"}).status_code == 422
    state = create(client).json()["assessment"]
    response = client.post(f'/api/v1/assessments/{state["id"]}/commands', json={"type": "ABANDON_ASSESSMENT", "expected_state_version": 0})
    assert response.status_code == 400


def test_scoring_configuration_frozen_on_create(setup, monkeypatch):
    _, client, _ = setup
    state = create(client).json()["assessment"]
    monkeypatch.setattr(assessment_domain, "SCORING_CONFIG", {"weights": {d: 0 for d in DIMENSIONS},
        "minimum_answered_per_dimension": 7, "thresholds": {"L2": 1000, "L3": 2000}, "minimum_correct_at_target_tier": 3})
    _, completed = finish(client, state)
    assert completed["result"]["overall_score"] == 100 and completed["result"]["sufficiency"] == "HIGH"


def test_bank_cell_shortage_and_duplicate_ids_block_creation(setup, monkeypatch):
    db, client, questions = setup
    monkeypatch.setattr(routes.bank, "QUESTION_BANK", [q for q in questions if not (q["dimension"] == "chapter" and q["difficulty"] == "L3")])
    assert not client.get("/api/v1/assessments/availability").json()["pilot_available"]
    assert create(client).status_code == 409
    monkeypatch.setattr(routes.bank, "QUESTION_BANK", [*questions, *deepcopy(questions)])
    assert not client.get("/api/v1/assessments/availability").json()["pilot_available"]
    assert create(client).status_code == 409
    assert db.scalar(select(func.count()).select_from(AssessmentSession)) == 0


def test_single_source_blocks_complete_trial(setup):
    db, client, _ = setup
    for row in db.scalars(select(AssessmentQuestionRevision)):
        row.payload = {**row.payload, "source": "单一来源"}
    db.commit()
    available = client.get("/api/v1/assessments/availability").json()
    assert available["pilot_question_count"] == 48 and not available["pilot_available"]
    response = create(client)
    assert response.status_code == 409 and response.json()["error"]["code"] == "ASSESSMENT_SOURCE_DIVERSITY_INSUFFICIENT"


def test_feature_switch_pauses_new_but_preserves_recovery(setup, monkeypatch):
    _, client, _ = setup
    state = create(client).json()["assessment"]
    monkeypatch.setattr(routes.config, "ASSESSMENT_ENABLED", False)
    assert not client.get("/api/v1/assessments/availability").json()["pilot_available"]
    response = create(client)
    assert response.status_code == 409 and response.json()["error"]["code"] == "ASSESSMENT_DISABLED"
    assert client.get(f'/api/v1/assessments/{state["id"]}').json()["assessment"] == state
    assert command(client, state, "SKIP_QUESTION", {"question_id": state["questions"][0]["id"]}).status_code == 200


def test_real_candidate_pool_source_diversity_and_trial_gate():
    assert can_assemble(QUESTION_BANK) and not can_assemble(QUESTION_BANK, True)
    for seed in range(30):
        frozen = select_questions(QUESTION_BANK, randomizer=Random(seed))
        counts = Counter(q["source"] for q in frozen)
        assert len(counts) >= 4 and max(counts.values()) <= 6
        assert len(frozen) == 24 and len({q["id"] for q in frozen}) == 24
        assert all(q["review_status"] == "DRAFT" for q in frozen)


def test_public_question_range_version_explicit_allowlist():
    public = assessment_domain.public_questions(QUESTION_BANK)
    for private, visible in zip(QUESTION_BANK, public):
        assert visible["material_extent"] == private["material_extent"]
        assert visible["passage_extent"] == private["passage_extent"]
        assert visible["text_version"] == private["text_version"]
        assert not set(visible).intersection({"answer_id", "explanation", "review_status", "reviewer", "tags"})
    basic = assessment_domain.public_questions(_bank())
    assert all("text_version" not in q for q in basic)


@pytest.mark.parametrize("change", [{"answer_id": "missing"}, {"options": [{"id": "same", "text": "1"}, {"id": "same", "text": "2"}]},
    {"stem": " "}, {"dimension": "translation"}, {"version": True}])
def test_question_validation(change):
    assert not valid_question({**_bank()[0], **change})


def test_formal_tier_gate_and_sample_insufficiency():
    questions = _bank()
    chosen = [q for q in questions if q["id"].endswith(("-0", "-1"))]
    answers = {q["id"]: "good" if q["difficulty"] == "L1" else "bad" for q in chosen}
    state = {"questions": chosen, "answers": answers, "mode": "FORMAL"}
    result = score(state)
    assert result["suggested_level"] == "L1"
    answers.update({q["id"]: "good" for q in chosen if q["difficulty"] == "L2"})
    assert score(state)["suggested_level"] == "L2"
    answers.update({q["id"]: "good" for q in chosen if q["difficulty"] == "L3"})
    assert score(state)["suggested_level"] == "L3"
    for q in chosen:
        if q["dimension"] == "chapter":
            answers[q["id"]] = None
    result = score(state)
    assert result["suggested_level"] is None and result["level_status"] == "INSUFFICIENT"
    assert result["dimensions"]["chapter"]["score"] is None


def test_lesson_ability_additive_nullable_and_conflict(setup):
    db, client, _ = setup
    url = "/api/v1/admin/lessons/test-lesson/ability"
    initial = client.get(url).json()["ability"]
    assert initial["ability_level"] is None and initial["version"] == 0
    payload = {"ability_level": "L2", "dimension_tags": ["syntax", "context"], "expected_version": 0,
        "actor": "隔离测试标定", "note": "测试，不代表已审核"}
    edited = client.patch(url, json=payload).json()["ability"]
    assert edited["version"] == 1 and edited["updated_at"].endswith("+00:00")
    assert client.patch(url, json={**payload, "ability_level": "L3"}).status_code == 409
    assert client.patch(url, json={**payload, "expected_version": 1, "dimension_tags": ["context", "context"]}).status_code == 422
    cleared = client.patch(url, json={**payload, "expected_version": 1, "ability_level": None, "dimension_tags": []})
    assert cleared.json()["ability"]["ability_level"] is None
    assert db.get(Lesson, "test-lesson").difficulty == "旧字段"
    assert client.get("/api/v1/admin/lessons/missing/ability").status_code == 404


def test_new_assessment_datetime_normalization_preserves_utc_instant():
    assert utc_iso(None) is None
    assert utc_iso(datetime(2026, 10, 7, 12, 26)) == "2026-10-07T12:26:00+00:00"
    assert utc_iso(datetime(2026, 10, 7, 20, 26, tzinfo=timezone(timedelta(hours=8)))) == "2026-10-07T12:26:00+00:00"
