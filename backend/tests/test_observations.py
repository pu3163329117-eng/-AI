"""Learning behavior provenance is tested only on isolated in-memory SQLite."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unicodedata import category
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import backend.main as main
from backend.db.session import Base, get_db
from backend.db.models import LearnerProfile, TrainingSession, TrainingEvent, CommandReceipt
from backend.db.observation_models import StageObservation
from backend.db.observations import persist_observations
from backend.domain.training import initial_snapshot, apply_command


@pytest.fixture
def setup():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False, autoflush=False)
    db.add_all([LearnerProfile(id="observation-profile", display_name="仅隔离测试", school_stage="JUNIOR", total_points=0, completed_levels=0),
        LearnerProfile(id="observation-other", display_name="他人隔离测试", school_stage="JUNIOR", total_points=0, completed_levels=0)])
    db.commit()
    main.app.dependency_overrides[get_db] = lambda: db
    client = TestClient(main.app)  # No context manager/lifespan: never open runtime DB.
    yield db, client
    client.close(); main.app.dependency_overrides.pop(get_db, None)
    db.close(); engine.dispose()


def new_session(db, legacy=False):
    snapshot = initial_snapshot()
    snapshot["profile_id"] = "observation-profile"
    if legacy:
        snapshot.pop("learning_trace")
    record = TrainingSession(profile_id="observation-profile", state_version=1, snapshot=snapshot)
    db.add(record); db.commit(); db.refresh(record)
    return record.id, deepcopy(record.snapshot)


def send(client, identifier, state, command, payload=None, key=None):
    return client.post(f"/api/v1/training/sessions/{identifier}/commands", headers={"Idempotency-Key": key or f'{command}-{state["state_version"]}'},
        json={"type": command, "expected_state_version": state["state_version"], "payload": payload or {}})


def updated(client, identifier, state, command, payload=None, key=None):
    response = send(client, identifier, state, command, payload, key)
    assert response.status_code == 200, response.text
    return response.json()["session"]


def selection(state, token=None):
    paragraphs = state["reading_context"]["paragraphs"]
    token = token or state["variable"]
    index = next(i for i, paragraph in enumerate(paragraphs) if token in paragraph)
    start = paragraphs[index].index(token)
    return {"paragraph_index": index, "start": start, "end": start + len(token)}


def reasoning(state):
    return {**selection(state, state["evidence"]), "reason": "仅测试表达，不代表开放理由已经审核", "conclusion": state["correct_answer"]}


def get_report(client):
    response = client.get("/api/v1/profiles/observation-profile/observations/report")
    assert response.status_code == 200, response.text
    return response.json()["report"]


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def finish_two_stages(client, identifier, state):
    state = updated(client, identifier, state, "SELECT_EVIDENCE")
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    state = updated(client, identifier, state, "CONTINUE_TO_TRANSFER")
    state = updated(client, identifier, state, "SELECT_EVIDENCE")
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    return state


def test_empty_report_null_rates_no_get_writes(setup):
    db, client = setup
    for _ in range(3):
        report = get_report(client)
        assert report["scope"] == "LEARNING_BEHAVIOR" and report["records"] == [] and report["trend"] == []
        assert report["totals"]["observed_stages"] == 0
        assert report["totals"]["first_no_recorded_assistance"]["accuracy"] is None
    assert count(db, StageObservation) == count(db, TrainingEvent) == count(db, CommandReceipt) == 0
    assert client.get("/api/v1/profiles/missing/observations/report").status_code == 404


def test_context_expansion_is_reading_not_assistance_and_input_not_mutated():
    before = initial_snapshot()
    original = deepcopy(before)
    result = apply_command(before, {"type": "REQUEST_MORE_CONTEXT", "payload": {"scope": "PARAGRAPH", **selection(before)}})
    assert before == original
    assert result.snapshot["learning_trace"]["stages"]["CORE"]["assistance_kinds"] == []
    assert [event["type"] for event in result.events] == ["training.context_expanded"]
    attempted = apply_command(result.snapshot, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": result.snapshot["correct_answer"]}})
    assert attempted.snapshot["learning_trace"]["stages"]["CORE"]["first_attempt"]["assistance_status"] == "NONE_RECORDED"


@pytest.mark.parametrize("kind", ["REQUEST_HINT", "SELECT_EVIDENCE", "REVISIT_VARIABLE", "SAVE_REASONING", "RECORD_ASSISTANCE"])
def test_answer_revealing_actions_before_first_are_recorded(setup, kind):
    db, client = setup
    identifier, state = new_session(db)
    payload = None
    if kind == "REVISIT_VARIABLE":
        state = updated(client, identifier, state, "DEFER_VARIABLE")
    elif kind == "SAVE_REASONING":
        payload = reasoning(state)
    elif kind == "RECORD_ASSISTANCE":
        payload = {"kind": "WORD_MEANING", **selection(state)}
    state = updated(client, identifier, state, kind, payload)
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    first = state["learning_trace"]["stages"]["CORE"]["first_attempt"]
    expected = {"REQUEST_HINT": "HINT", "SELECT_EVIDENCE": "PRESET_EVIDENCE", "REVISIT_VARIABLE": "PRESET_EVIDENCE",
        "SAVE_REASONING": "RULE_CHECK", "RECORD_ASSISTANCE": "WORD_MEANING"}[kind]
    assert first["assistance_status"] == "ASSISTED" and first["assistance_kinds"] == [expected]
    assert first["reason_review_status"] == "UNREVIEWED"
    report = get_report(client)
    assert report["totals"]["first_assisted"]["count"] == 1 and report["totals"]["first_no_recorded_assistance"]["count"] == 0


def test_first_wrong_frozen_retry_success_does_not_rewrite_first(setup):
    db, client = setup
    identifier, original = new_session(db)
    wrong = next(answer for answer in original["choices"] if answer != original["correct_answer"])
    first_response = send(client, identifier, original, "SUBMIT_ATTEMPT", {"answer": wrong}, key="first-lost-response")
    assert first_response.status_code == 200
    state = first_response.json()["session"]
    first = deepcopy(state["learning_trace"]["stages"]["CORE"]["first_attempt"])
    assert first["correct"] is False and first["assistance_status"] == "NONE_RECORDED"
    assert state["learning_trace"]["stages"]["CORE"]["assistance_kinds"] == ["FEEDBACK"]
    assert send(client, identifier, original, "SUBMIT_ATTEMPT", {"answer": wrong}, key="first-lost-response").json() == first_response.json()
    state = updated(client, identifier, state, "REQUEST_HINT")
    state = updated(client, identifier, state, "SAVE_REASONING", reasoning(state))
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    assert state["learning_trace"]["stages"]["CORE"]["first_attempt"] == first
    assert state["learning_trace"]["stages"]["CORE"]["attempt_count"] == 2
    record = get_report(client)["records"][0]
    assert record["first_correct"] is False and record["retry_completed"] and record["validated"]
    assert record["attempt_count"] == 2 and record["assistance_kinds"] == []
    assert count(db, StageObservation) == 1
    assert send(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}).status_code == 409
    sequences = list(db.scalars(select(TrainingEvent.sequence_no).where(TrainingEvent.session_id == identifier).order_by(TrainingEvent.sequence_no)))
    assert sequences == list(range(1, len(sequences) + 1))


def test_first_choice_and_evidence_coverage_are_distinct(setup):
    db, client = setup
    identifier, state = new_session(db)
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    first = state["learning_trace"]["stages"]["CORE"]["first_attempt"]
    assert first["correct"] and not first["evidence_rule_matched"] and not state["transfer_ready"]
    stats = get_report(client)["totals"]["first_no_recorded_assistance"]
    assert stats == {"count": 1, "correct_count": 1, "evidence_matched_count": 0, "accuracy": 100.0}


def test_core_transfer_separate_first_and_completion_dedup(setup):
    db, client = setup
    identifier, state = new_session(db)
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    state = updated(client, identifier, state, "SAVE_REASONING", reasoning(state))
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    core_first = deepcopy(state["learning_trace"]["stages"]["CORE"]["first_attempt"])
    state = updated(client, identifier, state, "CONTINUE_TO_TRANSFER")
    transfer = state["learning_trace"]["stages"]["TRANSFER"]
    assert transfer["first_attempt"] is None and transfer["assistance_kinds"] == []
    state = updated(client, identifier, state, "SAVE_REASONING", reasoning(state))
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    assert state["learning_trace"]["stages"]["CORE"]["first_attempt"] == core_first
    assert state["learning_trace"]["stages"]["TRANSFER"]["first_attempt"]["assistance_kinds"] == ["RULE_CHECK"]
    before_complete = deepcopy(state)
    response = send(client, identifier, before_complete, "COMPLETE_SESSION", key="complete-lost-response")
    assert response.status_code == 200
    assert send(client, identifier, before_complete, "COMPLETE_SESSION", key="complete-lost-response").json() == response.json()
    report = get_report(client)
    assert report["totals"]["observed_stages"] == 2 and report["totals"]["validated_stages"] == 2
    assert report["totals"]["CORE"]["first_no_recorded_assistance"]["count"] == 1
    assert report["totals"]["TRANSFER"]["first_assisted"]["count"] == 1
    assert report["totals"]["retry_validated_stages"] == 1
    assert count(db, StageObservation) == 2 and db.get(LearnerProfile, "observation-profile").total_points == 20


def test_legacy_unknown_not_backfilled_or_denominator(setup):
    db, client = setup
    identifier, state = new_session(db, legacy=True)
    state = updated(client, identifier, state, "REQUEST_HINT")
    state = updated(client, identifier, state, "RECORD_ASSISTANCE", {"kind": "WORD_MEANING", **selection(state)})
    state = finish_two_stages(client, identifier, state)
    assert "learning_trace" not in state
    report = get_report(client)
    assert report["totals"]["legacy_sessions"] == 1 and report["totals"]["unknown_stages"] == 2
    assert report["totals"]["observed_stages"] == 0 and report["trend"] == []
    assert report["totals"]["first_assisted"]["accuracy"] is None
    assert all(record["assistance_status"] == "UNKNOWN" and record["first_answer"] is None and record["retry_completed"] is None for record in report["records"])
    assert count(db, StageObservation) == 0


@pytest.mark.parametrize("changes", [{"kind": "HINT"}, {"start": True}, {"end": -1}, {"paragraph_index": 999}, {"raw_meaning": "fake"}])
def test_invalid_explicit_assistance_has_no_side_effects(setup, changes):
    db, client = setup
    identifier, state = new_session(db)
    response = send(client, identifier, state, "RECORD_ASSISTANCE", {"kind": "WORD_MEANING", **selection(state), **changes})
    assert response.status_code == 409
    assert count(db, TrainingEvent) == count(db, CommandReceipt) == count(db, StageObservation) == 0
    assert db.get(TrainingSession, identifier, populate_existing=True).state_version == 1


def test_frozen_codepoint_positions_and_punctuation_rejection():
    state = initial_snapshot()
    state["reading_context"] = {**state["reading_context"], "paragraphs": ["𠀀从师学。"], "full_text": "𠀀从师学。"}
    result = apply_command(state, {"type": "RECORD_ASSISTANCE", "payload": {"kind": "WORD_MEANING", "paragraph_index": 0, "start": 0, "end": 1}})
    assert result.events[0]["payload"]["token"] == "𠀀"
    with pytest.raises(ValueError, match="INVALID_CONTEXT_SELECTION"):
        apply_command(state, {"type": "RECORD_ASSISTANCE", "payload": {"kind": "WORD_MEANING", "paragraph_index": 0, "start": 4, "end": 5}})


def test_report_utc_timestamps_and_beijing_first_vs_validation_dates(setup):
    db, client = setup
    identifier, state = new_session(db)
    wrong = next(answer for answer in state["choices"] if answer != state["correct_answer"])
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": wrong})
    state = updated(client, identifier, state, "SELECT_EVIDENCE")
    state = updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]})
    first_time = datetime(2026, 10, 7, 16, 5, tzinfo=timezone.utc)
    validation_time = datetime(2026, 10, 8, 16, 5, tzinfo=timezone.utc)
    observation = db.scalar(select(StageObservation))
    observation.created_at = first_time
    validation = db.scalar(select(TrainingEvent).where(TrainingEvent.type == "training.answer_validated"))
    validation.created_at = validation_time
    db.commit()
    report = get_report(client)
    record = report["records"][0]
    assert record["first_submitted_at"].endswith("+00:00") and record["validated_at"].endswith("+00:00")
    assert report["trend"] == [
        {"date": "2026-10-08", "observed_stages": 1, "first_no_recorded_assistance_count": 1,
         "first_no_recorded_assistance_correct_count": 0, "first_assisted_count": 0, "first_assisted_correct_count": 0, "retry_validated_stages": 0},
        {"date": "2026-10-09", "observed_stages": 0, "first_no_recorded_assistance_count": 0,
         "first_no_recorded_assistance_correct_count": 0, "first_assisted_count": 0, "first_assisted_correct_count": 0, "retry_validated_stages": 1}]


def test_persistence_same_transaction_dedup_and_requires_source_event(setup):
    db, _client = setup
    identifier, state = new_session(db)
    result = apply_command(state, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": state["correct_answer"]}})
    record = db.get(TrainingSession, identifier)
    with pytest.raises(ValueError, match="OBSERVATION_SOURCE_EVENT_REQUIRED"):
        persist_observations(db, record, result, [])
    events = [TrainingEvent(session_id=identifier, sequence_no=i, type=event["type"], payload=event["payload"]) for i, event in enumerate(result.events, 1)]
    db.add_all(events); db.flush()
    persist_observations(db, record, result, events)
    persist_observations(db, record, result, events)
    db.flush()
    assert count(db, StageObservation) == 1
    db.rollback()
    assert count(db, StageObservation) == count(db, TrainingEvent) == 0


def test_main_observation_failure_rolls_back_cas_events_receipt_and_first(setup, monkeypatch):
    db, client = setup
    identifier, state = new_session(db)
    original = main.persist_observations

    def failure(*args, **kwargs):
        original(*args, **kwargs)
        raise IntegrityError("isolated failure after first observation", {}, RuntimeError("test"))

    monkeypatch.setattr(main, "persist_observations", failure)
    assert send(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}).status_code == 409
    assert count(db, StageObservation) == count(db, TrainingEvent) == count(db, CommandReceipt) == 0
    assert db.get(TrainingSession, identifier, populate_existing=True).state_version == 1
    assert db.get(LearnerProfile, "observation-profile").total_points == 0


def test_main_complete_failure_rolls_back_points_with_existing_observations(setup, monkeypatch):
    db, client = setup
    identifier, state = new_session(db)
    state = finish_two_stages(client, identifier, state)
    event_count, receipt_count = count(db, TrainingEvent), count(db, CommandReceipt)

    def failure(*_args, **_kwargs):
        raise IntegrityError("isolated completion failure", {}, RuntimeError("test"))

    monkeypatch.setattr(main, "persist_observations", failure)
    assert send(client, identifier, state, "COMPLETE_SESSION").status_code == 409
    assert count(db, TrainingEvent) == event_count and count(db, CommandReceipt) == receipt_count
    assert count(db, StageObservation) == 2
    profile = db.get(LearnerProfile, "observation-profile", populate_existing=True)
    assert profile.total_points == profile.completed_levels == 0
    assert not db.get(TrainingSession, identifier, populate_existing=True).snapshot["completed"]


def test_report_profile_scope_and_full_denominator_over_display_limit(setup):
    db, client = setup
    for i in range(53):
        identifier, state = new_session(db)
        updated(client, identifier, state, "SUBMIT_ATTEMPT", {"answer": state["correct_answer"]}, key=f"first-{i}")
    report = get_report(client)
    assert len(report["records"]) == 50 and report["totals"]["observed_stages"] == 53
    assert sum(day["observed_stages"] for day in report["trend"]) == 53
    other = client.get("/api/v1/profiles/observation-other/observations/report").json()["report"]
    assert other["totals"]["observed_stages"] == 0 and other["records"] == []
