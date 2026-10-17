"""Manual opinions in isolated databases, never actual teacher endorsement."""
from copy import deepcopy
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.ai.calibration_cases import build_cases
from backend.db.ai_reason_review_models import AIReasonReviewNote
from backend.db.models import TrainingSession, TrainingEvent, LearnerProfile
from backend.db.session import Base, get_db
from backend.main import app

ROOT = "/api/v1/admin/ai-reason-review/cases"


@pytest.fixture
def context(monkeypatch):
    import backend.ai.settings as settings
    import backend.ai.deepseek as deepseek
    def forbidden(*args, **kwargs):
        pytest.fail("manual notebook must not call provider or load a key")
    monkeypatch.setattr(settings, "load_settings", forbidden)
    monkeypatch.setattr(deepseek.DeepSeekProvider, "generate_structured", forbidden)
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    try:
        yield client, db
    finally:
        client.close(); app.dependency_overrides.pop(get_db, None); db.close(); engine.dispose()


def fields(**changes):
    return {"reviewer": "合成核对员，不代表实际教师", "decision": "NEEDS_REVISION",
            "context_sufficiency": "UNCERTAIN", "source_basis": "合成来源核对说明",
            "rationale": "合成测试意见，需核对人物关系。", "alternatives": None,
            "suggested_labels": ["UNSCORABLE"], **changes}


def request(client, index=0, **changes):
    case = build_cases()[index]
    detail = client.get(ROOT + "/" + case["id"]).json()
    return {"expected_suite_digest": detail["suite_digest"], "expected_input_digest": detail["input_digest"],
            "expected_revision": detail["revision"], "fields": fields(), **changes}


def save(client, body, key=None, index=0):
    return client.post(ROOT + "/" + build_cases()[index]["id"] + "/notes", json=body,
                       headers={"Idempotency-Key": key or str(uuid4())})


def test_empty_queue_and_detail_are_drafts_with_no_fabricated_opinions(context):
    client, db = context
    data = client.get(ROOT).json()
    assert data["total"] == 40 and data["recorded_cases"] == data["notes_total"] == 0
    assert data["review_status"] == "NOT_VERIFIED"
    assert not data["reviewer_identity_verified"] and not data["may_update_learning"]
    assert not data["live_ai_release_gate_satisfied"]
    detail = client.get(ROOT + "/" + build_cases()[0]["id"]).json()
    assert detail["notes"] == [] and detail["revision"] == 0
    assert detail["payload"] == build_cases()[0]["payload"]
    assert detail["development_expectation"]["review_status"] == "NOT_VERIFIED"
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 0


def test_opinions_append_and_do_not_publish_or_change_learning(context):
    client, db = context
    first = save(client, request(client)).json()
    assert first["saved"]["revision"] == 1 and not first["replayed"]
    second = save(client, request(client, fields=fields(decision="ACCEPTABLE", reviewer="第二位合成核对员"))).json()
    assert second["saved"]["revision"] == 2 and not second["reviewer_identity_verified"]
    detail = client.get(ROOT + "/" + build_cases()[0]["id"]).json()
    assert [r["fields"]["decision"] for r in detail["notes"]] == ["NEEDS_REVISION", "ACCEPTABLE"]
    queue = client.get(ROOT).json()
    assert queue["recorded_cases"] == 1 and queue["notes_total"] == 2
    assert queue["decision_counts"] == {"ACCEPTABLE": 1, "NEEDS_REVISION": 0, "UNCERTAIN": 0}
    assert detail["review_status"] == "NOT_VERIFIED" and not detail["semantic_accuracy_verified"]
    for model in (TrainingSession, TrainingEvent, LearnerProfile):
        assert db.scalar(select(func.count()).select_from(model)) == 0
    assert build_cases()[0]["review_status"] == "NOT_VERIFIED"


def test_idempotent_recovery_after_new_opinion_returns_original_receipt(context):
    client, db = context
    body = request(client)
    key = str(uuid4())
    first = save(client, body, key).json()
    save(client, request(client, fields=fields(decision="UNCERTAIN")))
    recovered = save(client, body, key).json()
    assert recovered["saved"] == first["saved"] and recovered["replayed"]
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 2
    changed = deepcopy(body); changed["fields"]["rationale"] += "改动"
    assert save(client, changed, key).json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


@pytest.mark.parametrize("change,code", [
    ({"expected_suite_digest": "0" * 64}, "AI_REVIEW_SUITE_CHANGED"),
    ({"expected_input_digest": "0" * 64}, "AI_REVIEW_SUITE_CHANGED"),
    ({"expected_revision": 1}, "AI_REVIEW_VERSION_CONFLICT"),
])
def test_version_conflict_never_overwrites(context, change, code):
    client, db = context
    assert save(client, request(client, **change)).json()["error"]["code"] == code
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 0


@pytest.mark.parametrize("patch", [
    {"reviewer": "   "}, {"decision": "APPROVED"}, {"context_sufficiency": "yes"},
    {"source_basis": ""}, {"rationale": ""}, {"rationale": "x" * 4001},
    {"suggested_labels": ["UNSCORABLE", "UNSCORABLE"]}, {"suggested_labels": ["COMPLETE_SESSION"]},
    {"score": 100}, {"alternatives": " "},
])
def test_invalid_opinions_fail_closed(context, patch):
    client, db = context
    assert save(client, request(client, fields=fields(**patch))).status_code == 422
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 0


def test_strict_version_and_client_gate_fields_rejected(context):
    client, _ = context
    assert save(client, request(client, expected_revision=True)).status_code == 422
    assert save(client, request(client, may_update_learning=True)).status_code == 422
    assert client.get(ROOT + "/unknown").status_code == 404
    assert client.delete(ROOT + "/" + build_cases()[0]["id"]).status_code == 405


@pytest.mark.parametrize("key", [None, "small", "x" * 65, " " * 16, "a/" * 16])
def test_bad_or_missing_idempotency_key_rejected(context, key):
    client, _ = context
    headers = {} if key is None else {"Idempotency-Key": key}
    response = client.post(ROOT + "/" + build_cases()[0]["id"] + "/notes", json=request(client), headers=headers)
    assert response.status_code == 400


def test_stale_second_writer_and_cross_case_key_reuse(context):
    client, db = context
    body = request(client)
    key = str(uuid4())
    assert save(client, body, key).status_code == 200
    assert save(client, body).json()["error"]["code"] == "AI_REVIEW_VERSION_CONFLICT"
    assert save(client, request(client, index=1), key, index=1).json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 1


def test_old_suite_opinions_are_not_counted_as_current(context):
    client, db = context
    record = AIReasonReviewNote(id=str(uuid4()), request_hash="1" * 64, suite_digest="0" * 64,
        input_digest="0" * 64, case_id=build_cases()[0]["id"], revision=1, fields=fields())
    db.add(record); db.commit()
    queue = client.get(ROOT).json()
    detail = client.get(ROOT + "/" + record.case_id).json()
    assert queue["recorded_cases"] == 0 and detail["revision"] == 0
    assert detail["historical_note_count"] == 1 and detail["notes"] == []


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "http://127.0.0.1:9999"])
def test_foreign_origins_rejected(context, origin):
    client, _ = context
    assert client.get(ROOT, headers={"Origin": origin}).status_code == 403


def test_nonloopback_requests_rejected_before_loading_database():
    with TestClient(app, base_url="http://192.168.1.5:5173", client=("192.168.1.8", 50000)) as client:
        assert client.get(ROOT).status_code == 403
