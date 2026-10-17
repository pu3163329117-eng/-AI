"""Read-only handover contracts in synthetic memory databases, not endorsements."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
from uuid import uuid4

from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.ai.calibration_cases import build_cases, suite_digest
from backend.ai.review_contracts import ReviewFields
from backend.db.ai_reason_review_models import AIReasonReviewNote
from backend.db.session import Base, get_db
from backend.main import app

ROOT = "/api/v1/admin/ai-reason-review"
GATES = {"review_status": "NOT_VERIFIED", "reviewer_identity_verified": False,
         "semantic_accuracy_verified": False, "may_update_learning": False,
         "live_ai_release_gate_satisfied": False}


@pytest.fixture
def export_context(monkeypatch):
    import backend.ai.deepseek as provider
    import backend.ai.settings as settings
    import backend.ai_routes as ai_routes

    def forbidden(*args, **kwargs):
        pytest.fail("handover export must not call a model or load model settings")

    monkeypatch.setattr(provider.DeepSeekProvider, "generate_structured", forbidden)
    monkeypatch.setattr(settings, "load_settings", forbidden)
    monkeypatch.setattr(ai_routes, "load_settings", forbidden)
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    try:
        yield client, db
    finally:
        client.close()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        db.close()
        engine.dispose()


def fields(**patch):
    return {"reviewer": "合成署名，不代表教师", "decision": "UNCERTAIN",
            "context_sufficiency": "UNCERTAIN", "source_basis": "合成来源核对说明",
            "rationale": "合成测试意见，不能作为教研结论。", "alternatives": None,
            "suggested_labels": ["UNSCORABLE"], **patch}


def save(client, case_id=None, **patch):
    case_id = case_id or build_cases()[0]["id"]
    detail = client.get(f"{ROOT}/cases/{case_id}").json()
    response = client.post(f"{ROOT}/cases/{case_id}/notes", headers={"Idempotency-Key": str(uuid4())},
        json={"expected_suite_digest": detail["suite_digest"], "expected_input_digest": detail["input_digest"],
              "expected_revision": detail["revision"], "fields": fields(**patch)})
    assert response.status_code == 200, response.text
    return response.json()["saved"]


def export(client):
    response = client.get(ROOT + "/export")
    assert response.status_code == 200, response.text
    return response.json()


def add_record(db, case, *, suite=None, input_digest=None, revision=1, opinion=None):
    record = AIReasonReviewNote(id=str(uuid4()), request_hash="1" * 64,
        suite_digest=suite or suite_digest(build_cases()), input_digest=input_digest or case["input_digest"],
        case_id=case["id"], revision=revision,
        fields=ReviewFields.model_validate(opinion or fields()).model_dump())
    db.add(record)
    return record


def assert_gates(data):
    assert {key: data[key] for key in GATES} == GATES


def test_empty_bundle_is_exact_coherent_draft_not_teacher_approval(export_context):
    client, db = export_context
    data = export(client)
    assert set(data) == set(GATES) | {"suite_version", "suite_digest", "format_version", "generated_at",
        "contains_self_entered_names", "queue", "cases", "comparison"}
    assert data["format_version"] == "ai-reason-review-bundle-v1"
    assert data["contains_self_entered_names"] is True
    generated = datetime.fromisoformat(data["generated_at"])
    assert generated.tzinfo is not None and generated.utcoffset() == timedelta(0)
    queue = client.get(ROOT + "/cases").json()
    assert data["queue"] == queue and queue["total"] == 40
    assert queue["recorded_cases"] == queue["notes_total"] == 0
    ids = [item["case_id"] for item in queue["items"]]
    assert [item["case_id"] for item in data["cases"]] == ids
    assert [item["case_id"] for item in data["comparison"]] == ids
    assert_gates(data)
    assert_gates(queue)
    for detail, comparison in zip(data["cases"], data["comparison"]):
        assert detail == client.get(f"{ROOT}/cases/{detail['case_id']}").json()
        assert_gates(detail)
        assert detail["development_expectation"]["review_status"] == "NOT_VERIFIED"
        assert detail["notes"] == [] and detail["revision"] == 0
        assert comparison == {"case_id": detail["case_id"], "note_count": 0,
            "status": "NO_OPINION", "differing_fields": []}
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 0


def test_one_self_entered_opinion_keeps_all_gates_closed(export_context):
    client, _ = export_context
    saved = save(client, decision="ACCEPTABLE")
    data = export(client)
    assert data["cases"][0]["notes"] == [saved]
    assert_gates(saved)
    assert_gates(data)
    assert data["comparison"][0] == {"case_id": saved["case_id"], "note_count": 1,
        "status": "ONE_OPINION", "differing_fields": []}
    assert data["queue"]["decision_counts"]["ACCEPTABLE"] == 1


def test_same_structured_fields_do_not_infer_identity_or_semantic_agreement(export_context):
    client, _ = export_context
    save(client)
    save(client, reviewer="另一个合成署名", source_basis="另一来源版本待核验",
         rationale="完全不同的文字理由不触发结构字段比较。", alternatives="另一种解释待核对")
    data = export(client)
    assert data["comparison"][0]["status"] == "FIELDS_MATCH"
    assert data["comparison"][0]["note_count"] == 2
    assert data["comparison"][0]["differing_fields"] == []
    assert_gates(data)


@pytest.mark.parametrize("patch,differing", [
    ({"decision": "NEEDS_REVISION"}, ["decision"]),
    ({"context_sufficiency": "INSUFFICIENT"}, ["context_sufficiency"]),
    ({"suggested_labels": ["WRONG_REASONING"]}, ["suggested_labels"]),
    ({"decision": "ACCEPTABLE", "context_sufficiency": "SUFFICIENT",
      "suggested_labels": ["CORRECT_REASONING"]}, ["decision", "context_sufficiency", "suggested_labels"]),
])
def test_structured_differences_have_fixed_field_order(export_context, patch, differing):
    client, _ = export_context
    save(client)
    save(client, **patch)
    comparison = export(client)["comparison"][0]
    assert comparison["status"] == "FIELDS_DIFFER"
    assert comparison["differing_fields"] == differing


def test_label_order_is_set_comparison_not_a_difference(export_context):
    client, _ = export_context
    labels = ["UNSCORABLE", "INSUFFICIENT_EVIDENCE"]
    save(client, suggested_labels=labels)
    save(client, suggested_labels=list(reversed(labels)))
    data = export(client)
    assert data["comparison"][0]["status"] == "FIELDS_MATCH"
    assert data["cases"][0]["notes"][0]["fields"]["suggested_labels"] == labels
    assert data["cases"][0]["notes"][1]["fields"]["suggested_labels"] == list(reversed(labels))


def test_earlier_disagreement_remains_when_latest_two_fields_match(export_context):
    client, _ = export_context
    save(client, decision="NEEDS_REVISION")
    save(client, decision="ACCEPTABLE")
    save(client, decision="ACCEPTABLE")
    data = export(client)
    comparison = data["comparison"][0]
    assert comparison["status"] == "FIELDS_DIFFER" and comparison["note_count"] == 3
    assert comparison["differing_fields"] == ["decision"]
    assert data["queue"]["items"][0]["decision"] == "ACCEPTABLE"


def test_old_suite_input_and_unknown_case_notes_do_not_pollute_current_snapshot(export_context):
    client, db = export_context
    cases = build_cases()
    add_record(db, cases[0], suite="0" * 64)
    add_record(db, cases[0], input_digest="0" * 64, revision=2)
    unknown = deepcopy(cases[0]); unknown["id"] = "retired-case-not-in-this-suite"
    add_record(db, unknown)
    db.commit()
    save(client)
    data = export(client)
    assert data["queue"] == client.get(ROOT + "/cases").json()
    assert data["queue"]["recorded_cases"] == data["queue"]["notes_total"] == 1
    assert data["cases"][0]["historical_note_count"] == 2
    assert len(data["cases"][0]["notes"]) == 1
    assert data["comparison"][0]["status"] == "ONE_OPINION"
    assert all(item["case_id"] != unknown["id"] for item in data["cases"])


def test_export_is_deterministic_except_timestamp_and_does_not_write_any_table(export_context):
    client, db = export_context
    original_cases = deepcopy(build_cases())
    save(client)
    before = {table.name: db.scalar(select(func.count()).select_from(table)) for table in Base.metadata.sorted_tables}
    first = export(client); second = export(client)
    first.pop("generated_at"); second.pop("generated_at")
    assert first == second
    after = {table.name: db.scalar(select(func.count()).select_from(table)) for table in Base.metadata.sorted_tables}
    assert before == after
    assert all(count == 0 for name, count in after.items() if name != "ai_reason_review_notes")
    assert build_cases() == original_cases


def test_export_uses_one_note_select_and_no_autoflush(export_context):
    client, db = export_context
    pending = add_record(db, build_cases()[0])
    statements = []

    def observe(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.lstrip().upper())

    event.listen(db.bind, "before_cursor_execute", observe)
    try:
        data = export(client)
    finally:
        event.remove(db.bind, "before_cursor_execute", observe)
    assert data["queue"]["notes_total"] == 0
    assert pending in db.new
    assert len([sql for sql in statements if sql.startswith("SELECT") and "AI_REASON_REVIEW_NOTES" in sql]) == 1
    assert not any(sql.startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements)
    db.rollback()


def test_attachment_headers_and_utf8_preserve_review_text(export_context):
    client, _ = export_context
    save(client, rationale="合成中文理由：人物关系需要核对。")
    response = client.get(ROOT + "/export")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;") and ".json" in disposition and disposition.isascii()
    assert json.loads(response.content.decode("utf-8"))["cases"][0]["notes"][0]["fields"]["rationale"] == "合成中文理由：人物关系需要核对。"


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "http://127.0.0.1:9999",
                                    "http://127.0.0.1:8000@evil.example:8000"])
def test_export_rejects_hostile_origins(export_context, origin):
    client, _ = export_context
    response = client.get(ROOT + "/export", headers={"Origin": origin})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "AI_LOCAL_PREVIEW_ONLY"


@pytest.mark.parametrize("base_url,peer", [
    ("http://192.168.1.5:8000", "192.168.1.8"),
    ("http://127.0.0.1:8000", "192.168.1.8"),
    ("http://public.example:8000", "127.0.0.1"),
])
def test_export_rejects_nonloopback_host_or_client_before_db(base_url, peer):
    previous = dict(app.dependency_overrides)

    def forbidden_db():
        pytest.fail("nonloopback export must be rejected before database access")

    app.dependency_overrides[get_db] = forbidden_db
    try:
        with TestClient(app, base_url=base_url, client=(peer, 50000)) as client:
            assert client.get(ROOT + "/export").status_code == 403
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def test_actual_utf8_bundle_over_8_mib_is_rejected_not_truncated(export_context):
    from backend.db.ai_reason_review_export import bundle, MAX_EXPORT_BYTES
    client, db = export_context
    assert MAX_EXPORT_BYTES == 8 * 1024 * 1024
    large_fields = fields(reviewer="合" * 80, source_basis="合" * 2000,
                          rationale="合" * 4000, alternatives="合" * 4000)
    for case in build_cases()[:3]:
        for revision in range(1, 101):
            add_record(db, case, revision=revision, opinion=large_fields)
    db.commit()
    encoded = JSONResponse(bundle(db)).body
    assert len(encoded.decode("utf-8")) < MAX_EXPORT_BYTES < len(encoded)
    response = client.get(ROOT + "/export")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "AI_REVIEW_EXPORT_TOO_LARGE"
    assert "cases" not in response.json()
    assert db.scalar(select(func.count()).select_from(AIReasonReviewNote)) == 300


def test_exact_encoded_byte_limit_is_inclusive_and_one_less_is_rejected(export_context, monkeypatch):
    import backend.db.ai_reason_review_export as exporting
    client, _ = export_context
    fixed_bundle = export(client)
    expected = JSONResponse(fixed_bundle).body
    monkeypatch.setattr(exporting, "bundle", lambda db: deepcopy(fixed_bundle))
    monkeypatch.setattr(exporting, "MAX_EXPORT_BYTES", len(expected))
    response = client.get(ROOT + "/export")
    assert response.status_code == 200 and response.content == expected
    monkeypatch.setattr(exporting, "MAX_EXPORT_BYTES", len(expected) - 1)
    response = client.get(ROOT + "/export")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "AI_REVIEW_EXPORT_TOO_LARGE"
