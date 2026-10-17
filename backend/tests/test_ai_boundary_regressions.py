"""Regression tests for malformed candidates, not semantic evaluation."""
import asyncio
from copy import deepcopy
import json

import pytest

from backend.ai.calibration_cases import build_cases
from backend.ai.calibration import compare_recorded, manifest
from backend.ai.providers import FakeProvider
from backend.ai.service import FeedbackService


def candidate(**changes):
    return {"label": "CORRECT_REASONING", "score": 1.0, "confidence": .64,
            "evidence_quality": .9, "matched_rubric_items": ["cite", "relate", "limit"],
            "evidence_ids": ["e1"], "misconception_codes": [],
            "next_action_recommendation": "RETRY_REASONING", **changes}


@pytest.mark.parametrize("change", [
    {"matched_rubric_items": ["cite", "cite"]},
    {"misconception_codes": ["MISSED_SUBJECT", "MISSED_SUBJECT"]},
])
def test_downgrade_cannot_hide_invalid_original_references(change):
    raw = json.dumps(candidate(**change))
    result = asyncio.run(FeedbackService(FakeProvider([raw, raw])).run("evaluator", build_cases()[0]["payload"]))
    assert result.error_code == "INVALID_OUTPUT"
    assert result.trace["attempts"] == 2


@pytest.mark.parametrize("confidence", [.64, .9])
def test_diagnostic_abstention_cannot_hide_duplicate_observations(confidence):
    raw = json.dumps({"diagnosis_code": "INSUFFICIENT_DATA", "confidence": confidence,
                     "supporting_observation_ids": ["o1", "o1"],
                     "recommended_hint_skill": "HUMAN_REVIEW"})
    result = asyncio.run(FeedbackService(FakeProvider([raw, raw])).run("diagnose",
        {"observations": [{"id": "o1", "text": "合成观察"}]}))
    assert result.error_code == "INVALID_OUTPUT"


def test_explicit_abstention_must_not_recommend_retry_as_if_it_were_a_judgment():
    raw = json.dumps(candidate(label="UNSCORABLE", score=None, confidence=None,
        evidence_quality=None, matched_rubric_items=[], evidence_ids=[]))
    result = asyncio.run(FeedbackService(FakeProvider([raw, raw])).run("evaluator", build_cases()[0]["payload"]))
    assert result.error_code == "INVALID_OUTPUT"
    assert result.output["next_action_recommendation"] == "HUMAN_REVIEW"


@pytest.mark.parametrize("field", ["student_reason", "student_conclusion", "target", "text_version"])
def test_unencodable_input_stops_before_any_provider_attempt(field):
    payload = deepcopy(build_cases()[0]["payload"])
    payload[field] = "invalid-\ud800-text"
    provider = FakeProvider()
    with pytest.raises(ValueError, match="^AI_INPUT_INVALID$"):
        asyncio.run(FeedbackService(provider).run("evaluator", payload))
    assert not provider.calls


def test_recorded_comparison_also_rejects_duplicates_before_abstention():
    info = manifest()
    case = build_cases()[0]
    batch = {key: info[key] for key in ("suite_version", "suite_digest", "prompt_version", "schema_version")}
    batch.update(origin="RECORDED_UNVERIFIED", responses=[{
        "case_id": case["id"], "input_digest": case["input_digest"], "status": "OK",
        "error_code": None, "attempts": 1,
        "raw_output": json.dumps(candidate(matched_rubric_items=["cite", "cite"]))}])
    report = compare_recorded(batch)
    assert report["contract_rejected"] == 1 and report["passed"] == 0
    assert report["metrics"]["validated_candidate_coverage"]["numerator"] == 0
