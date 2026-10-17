"""Offline harness tests; synthetic outputs are never semantic gold evidence."""
import asyncio
from copy import deepcopy
import json

import pytest

from backend.ai.calibration import compare_recorded, manifest, self_test
from backend.ai.calibration_cases import build_cases, digest
from backend.ai.contracts import EvaluatorInput
from backend.ai.providers import FakeProvider
from backend.ai.service import FeedbackService
from backend.scripts.ai_reason_calibration import main, parse_json_batch


def output(label="CORRECT_REASONING", **changes):
    abstain = label == "UNSCORABLE"
    value = {"label": label, "score": None if abstain else 1.0 if label == "CORRECT_REASONING" else .3,
             "confidence": None if abstain else .9, "evidence_quality": None if abstain else .9,
             "evidence_ids": [] if abstain else ["e1"], "matched_rubric_items": [] if abstain else ["cite", "relate", "limit"],
             "misconception_codes": [], "next_action_recommendation": "HUMAN_REVIEW" if abstain else "RETRY_REASONING"}
    return {**value, **changes}


def record(case, candidate=None, **changes):
    return {"case_id": case["id"], "input_digest": case["input_digest"], "status": "OK",
            "error_code": None, "raw_output": json.dumps(candidate or output(), ensure_ascii=False),
            "attempts": 1, **changes}


def batch(rows):
    data = manifest()
    return {key: data[key] for key in ("suite_version", "suite_digest", "prompt_version", "schema_version")} | {
        "origin": "RECORDED_UNVERIFIED", "responses": rows}


def test_drafts_cover_eight_targets_both_stages_and_never_claim_review():
    cases = build_cases()
    assert len(cases) == 40 and len({c["id"] for c in cases}) == 40
    assert {c["payload"]["target"] for c in cases} == set("从归去属坐穷假贻")
    for target in set("从归去属坐穷假贻"):
        assert {c["payload"]["stage"] for c in cases if c["payload"]["target"] == target} == {"CORE", "TRANSFER"}
    assert sum(c["expected_labels"] == ["CORRECT_REASONING"] for c in cases) == 16
    for case in cases:
        assert case["review_status"] == "NOT_VERIFIED"
        assert digest(case["payload"]) == case["input_digest"]
        EvaluatorInput.model_validate(case["payload"])
    assert digest(build_cases()) == digest(cases)


def test_supported_and_wrong_reason_pairs_keep_same_conclusion():
    cases = build_cases()
    for good in [c for c in cases if c["kind"] == "supported"]:
        bad = next(c for c in cases if c["id"] == good["id"].replace("-supported", "-wrong-reason"))
        assert good["payload"]["student_conclusion"] == bad["payload"]["student_conclusion"]
        assert good["payload"]["visible_evidence"] == bad["payload"]["visible_evidence"]
        assert good["payload"]["student_reason"] != bad["payload"]["student_reason"]


def test_manifest_has_only_minimal_model_payload_and_keeps_expectations_local():
    data = manifest()
    assert not data["live_ai_release_gate_satisfied"] and not data["may_update_learning"]
    case = data["cases"][0]
    assert "expected_labels" not in case and "review_note" not in case
    assert set(case["payload"]) == {"stage", "text_version", "target", "visible_evidence", "student_reason", "student_conclusion", "rubric"}
    provider = FakeProvider([json.dumps(output())])
    asyncio.run(FeedbackService(provider).run("evaluator", case["payload"]))
    wire = json.loads(provider.calls[0].data_json)
    assert wire == case["payload"]
    assert "expected_labels" not in wire and "profile_id" not in wire


def test_self_test_reports_plumbing_only_and_suppresses_semantic_metrics():
    report = asyncio.run(self_test())
    assert report["passed"] == report["total"] == 40 and report["simulated"]
    assert report["origin"] == "SELF_TEST" and report["metrics"] is None
    assert not report["semantic_accuracy_verified"] and not report["live_ai_release_gate_satisfied"]
    attacks = [c for c in report["checks"] if c["kind"] == "instruction-attack"]
    assert len(attacks) == 2 and all(c["attempts"] == 0 and c["passed"] for c in attacks)


def test_empty_batch_has_null_rates_and_explicit_missing_cases():
    report = compare_recorded(batch([]))
    assert report["missing"] == report["total"] == 40 and report["passed"] == 0
    assert report["metrics"]["draft_false_acceptance"]["rate"] is None
    assert report["metrics"]["draft_label_agreement"]["rate"] is None
    assert report["metrics"]["validated_candidate_coverage"]["rate"] == 0


@pytest.mark.parametrize("field", ["suite_version", "suite_digest", "prompt_version", "schema_version", "origin"])
def test_mismatched_version_or_unverified_origin_cannot_be_compared(field):
    value = batch([])
    value[field] = "0" * 64 if field == "suite_digest" else "wrong"
    with pytest.raises(ValueError, match="^CALIBRATION_RECORD_INVALID$"):
        compare_recorded(value)


@pytest.mark.parametrize("change", ["duplicate", "unknown", "digest", "extra", "bool-attempts", "over-attempts", "null-ok", "fallback-candidate", "fake-status"])
def test_bad_record_shapes_fail_closed_without_echoing_input(change):
    row = record(build_cases()[0])
    value = batch([row])
    if change == "duplicate": value["responses"].append(deepcopy(row))
    elif change == "unknown": row["case_id"] = "not-a-case"
    elif change == "digest": row["input_digest"] = "0" * 64
    elif change == "extra": row["student_reason"] = "private-text-that-must-not-appear"
    elif change == "bool-attempts": row["attempts"] = True
    elif change == "over-attempts": row["attempts"] = 3
    elif change == "null-ok": row["raw_output"] = None
    elif change == "fallback-candidate": row.update(status="FALLBACK", error_code="INVALID_OUTPUT")
    else: row["status"] = "SUCCESS"
    with pytest.raises(ValueError, match="^CALIBRATION_RECORD_INVALID$") as error:
        compare_recorded(value)
    assert "private-text" not in str(error.value)


def test_false_acceptance_and_false_rejection_are_visible_not_hidden_by_correct_options():
    good, bad = build_cases()[:2]
    report = compare_recorded(batch([record(good, output("WRONG_REASONING")), record(bad)]))
    assert report["metrics"]["draft_false_acceptance"] == {"numerator": 1, "denominator": 1, "rate": 1}
    assert report["metrics"]["draft_false_rejection"]["rate"] == 1
    assert report["passed"] == 0 and report["missing"] == 38
    assert not report["semantic_accuracy_verified"]


def test_abstention_is_separate_from_false_rejection_and_never_means_perfect_accuracy():
    good, bad = build_cases()[:2]
    report = compare_recorded(batch([record(good, output("UNSCORABLE")), record(bad, output("UNSCORABLE"))]))
    assert report["metrics"]["draft_false_acceptance"]["rate"] is None
    assert report["metrics"]["draft_false_rejection"]["rate"] is None
    assert report["metrics"]["positive_abstention"]["rate"] == 1
    assert report["metrics"]["candidate_abstention"]["rate"] == 1
    assert report["metrics"]["known_reference_ids_before_validation"]["rate"] is None


def test_low_confidence_uses_production_abstention_gate():
    case = build_cases()[0]
    report = compare_recorded(batch([record(case, output(confidence=.64))]))
    assert report["checks"][0]["candidate_label"] == "UNSCORABLE"
    assert not report["checks"][0]["passed"]
    assert report["metrics"]["positive_abstention"]["rate"] == 1


@pytest.mark.parametrize("candidate", [output(evidence_ids=["made-up"]), output(matched_rubric_items=["unknown"]),
    output(evidence_ids=["e1", "e1"]), output(score=True), {"label": "CORRECT_REASONING"}])
def test_invalid_candidate_is_not_counted_as_valid_semantic_success(candidate):
    report = compare_recorded(batch([record(build_cases()[0], candidate)]))
    assert report["contract_rejected"] == 1 and report["passed"] == 0
    assert report["metrics"]["draft_label_agreement"]["denominator"] == 0
    assert report["checks"][0]["candidate_label"] is None


def test_known_reference_is_not_semantic_proof_and_missing_relation_is_detected():
    report = compare_recorded(batch([record(build_cases()[0], output(matched_rubric_items=["cite"]))]))
    assert report["metrics"]["known_reference_ids_before_validation"]["rate"] == 1
    assert report["metrics"]["semantic_citation_accuracy"] is None
    assert report["checks"][0]["draft_label_match"] is True
    assert report["checks"][0]["draft_criteria_match"] is False
    assert report["passed"] == 0


def test_instruction_attack_cannot_pass_with_a_full_score_or_after_provider_call():
    case = next(c for c in build_cases() if c["id"] == "injection-reason")
    report = compare_recorded(batch([record(case)]))
    check = next(c for c in report["checks"] if c["case_id"] == case["id"])
    assert check["state"] == "BOUNDARY_MISMATCH" and not check["passed"]
    row = record(case, status="FALLBACK", error_code="SAFETY_BLOCKED", raw_output=None, attempts=1)
    assert compare_recorded(batch([row]))["passed"] == 0
    row["attempts"] = 0
    assert compare_recorded(batch([row]))["passed"] == 1


def test_inputs_and_records_not_mutated_and_reports_contain_no_raw_text():
    cases = build_cases()
    value = batch([record(cases[0])])
    before = deepcopy(value)
    result = compare_recorded(value)
    assert value == before
    encoded = json.dumps(result, ensure_ascii=False)
    assert cases[0]["payload"]["student_reason"] not in encoded
    assert "raw_output" not in encoded and "api_key" not in encoded


@pytest.mark.parametrize("raw", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'])
def test_batch_parser_rejects_duplicate_keys_and_nonfinite_values(raw):
    with pytest.raises(ValueError): parse_json_batch(raw)


def test_cli_default_does_not_load_settings_or_call_a_model(monkeypatch, capsys):
    import backend.ai.settings as settings
    monkeypatch.setattr(settings, "load_settings", lambda: pytest.fail("must not load a key"))
    assert main([]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "NOT_RUN" and not result["external_call_attempted"]


def test_cli_reports_invalid_file_without_echoing_its_contents(tmp_path, capsys):
    path = tmp_path / "responses.json"
    path.write_text('{"private":"not-to-echo"}', encoding="utf-8")
    assert main(["--responses", str(path)]) == 1
    result = capsys.readouterr().out
    assert "not-to-echo" not in result and "CALIBRATION_RECORD_INVALID" in result


def test_cli_partial_bom_file_reports_missing_cases_and_nonzero_exit(tmp_path, capsys):
    path = tmp_path / "partial.json"
    path.write_text(json.dumps(batch([record(build_cases()[0])])), encoding="utf-8-sig")
    assert main(["--responses", str(path)]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["passed"] == 1 and report["missing"] == 39
    assert not report["live_ai_release_gate_satisfied"]


def test_cli_over_limit_file_is_rejected(tmp_path, capsys):
    path = tmp_path / "too-large.json"
    path.write_bytes(b" " * 2_000_001)
    assert main(["--responses", str(path)]) == 1
    assert "CALIBRATION_RECORD_INVALID" in capsys.readouterr().out


def test_cli_export_and_self_test_are_explicit_and_live_flag_does_not_exist(capsys):
    assert main(["--export-inputs"]) == 0
    assert json.loads(capsys.readouterr().out)["total"] == 40
    assert main(["--self-test"]) == 0
    assert json.loads(capsys.readouterr().out)["metrics"] is None
    with pytest.raises(SystemExit): main(["--live"])
