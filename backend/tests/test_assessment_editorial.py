"""Never bind to the runtime DB; all signatures below are isolated test fixtures."""
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.db.session import Base, get_db
from backend.db.assessment import seed_assessment_bank, bank_questions
from backend.db.assessment_models import AssessmentQuestionRevision, AssessmentSession
from backend.db.assessment_editorial_models import AssessmentQuestionHead, AssessmentEditorialReceipt
from backend.db.models import LearnerProfile
from backend.domain.assessment_bank import QUESTION_BANK, BANK_VERSION
from backend.domain import assessment_editorial as domain
from backend import assessment_editorial_routes as routes
from backend import assessment_routes

PREFIX = "/api/v1/admin/assessment/questions/"


@pytest.fixture
def setup():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    seed_assessment_bank(db)
    db.add(LearnerProfile(id="editorial-test", display_name="测试不是教师签名", school_stage="JUNIOR"))
    db.commit()
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(assessment_routes.router)
    app.dependency_overrides[get_db] = lambda: db

    @app.exception_handler(HTTPException)
    async def errors(_req, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    client = TestClient(app)
    yield db, client
    client.close()
    db.close()
    engine.dispose()


def get(client, q=None):
    return client.get(PREFIX + (q or QUESTION_BANK[0]["id"])).json()


def edit_body(current):
    fields = set(routes.QuestionFields.model_fields)
    question = {k: deepcopy(v) for k, v in current["question"].items() if k in fields}
    return {"expected_version": current["version"], "actor": "隔离测试编辑", "note": "仅测试校验，不是实际审核",
            "question": question}


def test_bad_span_has_explicit_read_only_validation_and_rejection_receipt(setup):
    db, client = setup
    current = get(client)
    assert current["validation_valid"] is True and current["validation_error"] is None
    row = db.get(AssessmentQuestionRevision, (current["question"]["id"], current["revision_version"]))
    payload = deepcopy(row.payload)
    payload["full_text_start"] += 1
    row.payload = payload
    db.commit()
    broken = get(client)
    assert broken["validation_valid"] is False
    assert broken["validation_error"] == "ASSESSMENT_QUESTION_SPAN_INVALID"
    rejected = review(client, broken, key="bad-span-reject", decision="REJECT")
    assert rejected.status_code == 200 and rejected.json()["validation_valid"] is False
    assert rejected.json()["history"][0]["validation_valid"] is False
    assert review(client, broken, key="bad-span-reject", decision="REJECT").json() == rejected.json()
    assert review(client, rejected.json(), key="bad-span-approve").status_code == 422


def review(client, current, key="review", decision="APPROVE"):
    return client.post(PREFIX + current["question"]["id"] + "/review", headers={"Idempotency-Key": key},
        json={"expected_version": current["version"], "actor": "隔离测试署名", "note": "隔离数据库核验依据，不用于运行库",
              "decision": decision})


def test_list_filters_read_only_pagination_and_seed_history(setup):
    db, client = setup
    result = client.get(PREFIX.rstrip("/") + "?dimension=syntax&review_status=DRAFT&limit=3&offset=2").json()
    assert result["total"] == 12 and len(result["items"]) == 3
    assert result["disclaimer"] == domain.DISCLAIMER
    current = get(client)
    assert current["version"] == 0 and current["revision_version"] == BANK_VERSION
    assert current["history"][0]["action"] == "SEED"
    assert current["reviewer_is_authenticated"] is False
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionHead)) == 0
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 0
    assert client.get(PREFIX.rstrip("/") + "?limit=0").status_code == 422
    assert client.get(PREFIX + "missing").status_code == 404


def test_edit_append_only_review_reset_replay_and_conflict(setup):
    db, client = setup
    current = get(client)
    original = deepcopy(current["question"])
    body = edit_body(current)
    body["question"]["stem"] += "【隔离编辑】"
    path = PREFIX + original["id"]
    assert client.patch(path, json=body).status_code == 400
    response = client.patch(path, json=body, headers={"Idempotency-Key": "edit"})
    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["version"] == 1 and edited["question"]["review_status"] == "DRAFT"
    assert edited["question"]["reviewer"] is None
    assert edited["history"][0]["payload"] == edited["question"]
    approved = review(client, edited).json()
    assert approved["version"] == 2 and approved["question"]["review_status"] == "APPROVED"
    assert approved["question"]["reviewer"] == "隔离测试署名"
    assert client.patch(path, json=body, headers={"Idempotency-Key": "edit"}).json() == edited
    reused = deepcopy(body)
    reused["note"] += "改变"
    assert client.patch(path, json=reused, headers={"Idempotency-Key": "edit"}).status_code == 409
    assert client.patch(path, json=body, headers={"Idempotency-Key": "stale"}).status_code == 409
    reset = client.patch(path, json=edit_body(approved), headers={"Idempotency-Key": "reset"}).json()
    assert reset["version"] == 3 and reset["question"]["review_status"] == "DRAFT"
    assert reset["question"]["reviewed_at"] is None
    assert db.get(AssessmentQuestionRevision, (original["id"], BANK_VERSION)).payload == original
    seed_assessment_bank(db)
    db.commit()
    assert get(client) == reset
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 3


@pytest.mark.parametrize("case", ["answer", "duplicate_id", "duplicate_text", "blank_stem", "source", "span", "text_version", "metadata", "chapter", "blank_actor", "blank_note", "boolean_version"])
def test_invalid_edits_never_write(setup, case):
    db, client = setup
    current = get(client)
    body = edit_body(current)
    q = body["question"]
    if case == "answer": q["answer_id"] = "missing"
    elif case == "duplicate_id": q["options"][1]["id"] = q["options"][0]["id"]
    elif case == "duplicate_text": q["options"][1]["text"] = q["options"][0]["text"]
    elif case == "blank_stem": q["stem"] = "  "
    elif case == "source": q["source_url"] = "https://evil.example/source"
    elif case == "span": q["end"] += 1
    elif case == "text_version": q["text_version"] = "fictional-edition"
    elif case == "metadata": q["review_status"] = "APPROVED"
    elif case == "chapter": q["dimension"] = "chapter"
    elif case == "blank_actor": body["actor"] = "  "
    elif case == "blank_note": body["note"] = "\t"
    elif case == "boolean_version": body["expected_version"] = False
    response = client.patch(PREFIX + q.get("id", current["question"]["id"]), json=body, headers={"Idempotency-Key": case})
    assert response.status_code == 422, response.text
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionRevision)) == 48
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 0
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionHead)) == 0


def test_rejection_excluded_pilot_formal_and_versioned_bank_freeze(setup):
    db, client = setup
    first = client.post("/api/v1/assessments", json={"profile_id": "editorial-test", "mode": "PILOT"}).json()["assessment"]
    frozen = deepcopy(db.get(AssessmentSession, first["id"]).snapshot)
    current = get(client, first["questions"][0]["id"])
    rejected = review(client, current, decision="REJECT").json()
    assert rejected["question"]["review_status"] == "REJECTED"
    available = client.get("/api/v1/assessments/availability").json()
    assert available["pilot_question_count"] == 47 and available["approved_question_count"] == 0
    assert not available["formal_available"]
    assert db.get(AssessmentSession, first["id"]).snapshot == frozen
    assert client.get("/api/v1/assessments/" + first["id"]).json()["assessment"] == first
    assert any(q["id"] == current["question"]["id"] and q["review_status"] == "REJECTED" for q in bank_questions(db, QUESTION_BANK))
    db.add(LearnerProfile(id="second-test", display_name="隔离新卷", school_stage="JUNIOR"))
    db.commit()
    second = client.post("/api/v1/assessments", json={"profile_id": "second-test", "mode": "PILOT"}).json()["assessment"]
    assert second["bank_version"].startswith(BANK_VERSION + ":")
    assert rejected["question"]["id"] not in {q["id"] for q in second["questions"]}


def test_review_unknown_response_same_key_and_blank_basis(setup):
    db, client = setup
    current = get(client)
    result = review(client, current)
    assert result.status_code == 200
    assert review(client, current).json() == result.json()
    assert review(client, current, key="other").status_code == 409
    body = {"expected_version": 1, "actor": "人工输入未认证", "note": " ", "decision": "APPROVE"}
    assert client.post(PREFIX + current["question"]["id"] + "/review", json=body,
                       headers={"Idempotency-Key": "blank"}).status_code == 422
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 1


def test_review_validates_existing_source_fail_closed(setup):
    db, client = setup
    current = get(client)
    row = db.get(AssessmentQuestionRevision, (current["question"]["id"], BANK_VERSION))
    malformed = deepcopy(row.payload)
    malformed["full_text_start"] += 1
    row.payload = malformed  # Deliberately corrupted fixture, never real data.
    db.commit()
    assert review(client, current).status_code == 422
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 0
    result = review(client, current, key="reject-broken-source", decision="REJECT")
    assert result.status_code == 200
    assert result.json()["question"]["review_status"] == "REJECTED"
    assert client.get("/api/v1/assessments/availability").json()["pilot_question_count"] == 47


def test_receipt_failure_rolls_back_head_and_revision(setup, monkeypatch):
    db, client = setup
    current = get(client)
    original_commit = db.commit
    def failed_commit():
        raise IntegrityError("isolated receipt failure", {}, Exception("fixture"))
    monkeypatch.setattr(db, "commit", failed_commit)
    assert review(client, current).status_code == 409
    monkeypatch.setattr(db, "commit", original_commit)
    assert get(client) == current
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionRevision)) == 48
    assert db.scalar(select(func.count()).select_from(AssessmentQuestionHead)) == 0
    assert db.scalar(select(func.count()).select_from(AssessmentEditorialReceipt)) == 0
    assert review(client, current).status_code == 200


def test_source_frozen_unicode_offsets_and_dimension_change(setup):
    db, client = setup
    current = get(client)
    body = edit_body(current)
    body["question"]["dimension"] = "syntax"
    body["question"]["difficulty"] = "L3"
    result = client.patch(PREFIX + current["question"]["id"], json=body,
                          headers={"Idempotency-Key": "dimension"})
    assert result.status_code == 200
    changed = result.json()
    assert changed["question"]["dimension"] == "syntax"
    assert changed["question"]["full_text_start"] == current["question"]["full_text_start"]
    assert review(client, changed).status_code == 200


def test_review_rejected_current_filter_no_new_seed_overwrite(setup):
    db, client = setup
    current = get(client)
    rejected = review(client, current, decision="REJECT").json()
    assert client.get(PREFIX.rstrip("/") + "?review_status=REJECTED").json()["total"] == 1
    assert client.get(PREFIX.rstrip("/") + "?review_status=DRAFT").json()["total"] == 47
    seed_assessment_bank(db)
    db.commit()
    assert get(client) == rejected
    approved = review(client, rejected, key="second-decision").json()
    assert approved["version"] == 2 and approved["question"]["review_status"] == "APPROVED"
    assert len(approved["history"]) == 3


def test_idempotency_cross_operation_reuse_is_rejected(setup):
    db, client = setup
    current = get(client)
    approved = review(client, current, key="shared").json()
    response = client.patch(PREFIX + current["question"]["id"], json=edit_body(approved),
                            headers={"Idempotency-Key": "shared"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert get(client) == approved


@pytest.mark.parametrize("message,status", [("database is locked", 409), ("disk I/O error", 503)])
def test_storage_errors_not_mislabelled_as_conflicts(setup, monkeypatch, message, status):
    db, client = setup
    current = get(client)
    original_commit = db.commit
    def failed_commit():
        raise OperationalError("isolated storage failure", {}, Exception(message))
    monkeypatch.setattr(db, "commit", failed_commit)
    result = review(client, current)
    assert result.status_code == status
    monkeypatch.setattr(db, "commit", original_commit)
    assert get(client) == current
    assert review(client, current).status_code == 200


def test_new_authored_seed_revision_never_overwrites_editorial_head(setup):
    db, client = setup
    current = get(client)
    approved = review(client, current).json()
    future = deepcopy(QUESTION_BANK)
    future[0]["version"] = "future-seed"
    future[0]["stem"] = "新种子绝不覆盖原审核头"
    seed_assessment_bank(db, future, "future-bank")
    db.commit()
    result = get(client)
    assert result["question"] == approved["question"]
    assert result["version"] == 1
    assert result["history"][0]["payload"] == result["question"]
    assert len(result["history"]) == 3
    assert bank_questions(db, future)[0] == approved["question"]
