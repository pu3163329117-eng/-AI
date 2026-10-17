"""Read-only comparison of recorded candidates with unreviewed draft cases.

This measures agreement with developer expectations, NOT semantic accuracy.
No model configuration, network client, database or learning commands are used.
"""
import json
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .calibration_cases import SUITE_VERSION, build_cases, suite_digest
from .contracts import ClosedModel, EvaluatorInput, SCHEMA_VERSION
from .prompts import PROMPT_VERSION
from .providers import FakeProvider, ProviderError
from .service import FeedbackService, parse_json, validate_output

Hash = Annotated[str, Field(strict=True, pattern=r"^[0-9a-f]{64}$")]
ErrorCode = Literal["PROVIDER_TIMEOUT", "RATE_LIMITED", "INVALID_OUTPUT", "SAFETY_BLOCKED", "PROVIDER_UNAVAILABLE"]


class RecordedResponse(ClosedModel):
    case_id: Annotated[str, Field(strict=True, min_length=1, max_length=100)]
    input_digest: Hash
    status: Literal["OK", "FALLBACK"]
    error_code: ErrorCode | None
    raw_output: Annotated[str, Field(strict=True, min_length=1, max_length=32_000)] | None
    attempts: Annotated[int, Field(strict=True, ge=0, le=2)]

    @model_validator(mode="after")
    def coherent_result(self):
        if self.status == "OK":
            if self.error_code is not None or self.raw_output is None or self.attempts < 1:
                raise ValueError("Incoherent candidate")
        elif self.error_code is None or self.raw_output is not None:
            raise ValueError("Fallback must not carry a raw candidate")
        return self


class RecordedRun(ClosedModel):
    suite_version: Annotated[str, Field(strict=True, min_length=1, max_length=100)]
    suite_digest: Hash
    prompt_version: Annotated[str, Field(strict=True, min_length=1, max_length=100)]
    schema_version: Annotated[str, Field(strict=True, min_length=1, max_length=100)]
    # This is not authenticated evidence that the responses came from a model.
    origin: Literal["RECORDED_UNVERIFIED"]
    responses: Annotated[list[RecordedResponse], Field(max_length=128)]


def manifest():
    cases = build_cases()
    return {"suite_version": SUITE_VERSION, "suite_digest": suite_digest(cases),
            "prompt_version": PROMPT_VERSION, "schema_version": SCHEMA_VERSION,
            "review_status": "NOT_VERIFIED", "data_kind": "synthetic",
            "total": len(cases), "may_update_learning": False,
            "live_ai_release_gate_satisfied": False,
            "cases": [{"case_id": c["id"], "input_digest": c["input_digest"],
                       "source": c["source"], "kind": c["kind"], "payload": c["payload"]} for c in cases]}


def ratio(numerator, denominator):
    return {"numerator": numerator, "denominator": denominator,
            "rate": numerator / denominator if denominator else None}


def compare_recorded(value):
    """Reject mismatched batches, and count missing/rejected rows separately.

    Never repair a stored response or call a provider. Original citations are
    checked before validation; only known IDs are structural citation validity.
    The local required-ID/rubric comparisons are merely draft expectations.
    """
    try:
        run = RecordedRun.model_validate(value)
        cases = build_cases()
        if (run.suite_version != SUITE_VERSION or run.suite_digest != suite_digest(cases)
            or run.prompt_version != PROMPT_VERSION or run.schema_version != SCHEMA_VERSION):
            raise ValueError("Version mismatch")
        known = {c["id"]: c for c in cases}
        rows = {r.case_id: r for r in run.responses}
        if len(rows) != len(run.responses) or not rows.keys() <= known.keys():
            raise ValueError("Unknown or duplicate case")
        if any(row.input_digest != known[key]["input_digest"] for key, row in rows.items()):
            raise ValueError("Input mismatch")
    except (ValueError, TypeError, RecursionError):
        raise ValueError("CALIBRATION_RECORD_INVALID") from None

    checks, valid, reference_checks = [], [], []
    for case in cases:
        row = rows.get(case["id"])
        check = {"case_id": case["id"], "kind": case["kind"], "target": case["payload"]["target"],
                 "stage": case["payload"]["stage"], "state": "MISSING", "passed": False,
                 "candidate_label": None, "draft_label_match": None,
                 "draft_evidence_match": None, "draft_criteria_match": None}
        if row:
            check.update(state="FALLBACK" if row.status == "FALLBACK" else "CANDIDATE",
                         error_code=row.error_code, attempts=row.attempts)
            if case["expected_error"]:
                # Obvious instruction attacks must stop before a provider call.
                check["passed"] = row.status == "FALLBACK" and row.error_code == case["expected_error"] and row.attempts == 0
                if not check["passed"]:
                    check["state"] = "BOUNDARY_MISMATCH"
            elif row.status == "OK":
                try:
                    raw = parse_json(row.raw_output)
                    ids = raw.get("evidence_ids") if isinstance(raw, dict) else None
                    if isinstance(ids, list) and ids:
                        allowed = {e["id"] for e in case["payload"]["visible_evidence"]}
                        reference_checks.append(all(isinstance(i, str) and i in allowed for i in ids))
                    data = EvaluatorInput.model_validate(case["payload"])
                    candidate = validate_output("evaluator", row.raw_output, data, ())
                    # This is the same confidence/closed-schema gate as preview.
                    check["candidate_label"] = candidate["label"]
                    check["draft_label_match"] = candidate["label"] in case["expected_labels"]
                    check["draft_evidence_match"] = set(case["required_evidence"]) <= set(candidate["evidence_ids"])
                    check["draft_criteria_match"] = set(case["required_criteria"]) <= set(candidate["matched_rubric_items"])
                    # Abstention need not assert supporting evidence or criteria.
                    if candidate["label"] == "UNSCORABLE":
                        check["draft_evidence_match"] = None
                        check["draft_criteria_match"] = None
                    check["passed"] = bool(check["draft_label_match"] and
                        (candidate["label"] == "UNSCORABLE" or check["draft_evidence_match"] and check["draft_criteria_match"]))
                    valid.append((case, candidate, check))
                except (ProviderError, ValueError, TypeError, RecursionError):
                    check.update(state="CONTRACT_REJECTED", error_code="INVALID_OUTPUT")
        checks.append(check)

    positives = [v for v in valid if v[0]["expected_labels"] == ["CORRECT_REASONING"]]
    negatives = [v for v in valid if v[0]["expected_labels"] != ["CORRECT_REASONING"]]
    positive_decisions = [v for v in positives if v[1]["label"] != "UNSCORABLE"]
    negative_decisions = [v for v in negatives if v[1]["label"] != "UNSCORABLE"]
    return {
        "suite_version": SUITE_VERSION, "suite_digest": run.suite_digest,
        "prompt_version": run.prompt_version, "schema_version": run.schema_version,
        "origin": "RECORDED_UNVERIFIED", "review_status": "NOT_VERIFIED",
        "semantic_accuracy_verified": False, "may_update_learning": False,
        "live_ai_release_gate_satisfied": False,
        "scope": "Agreement with developer drafts; not teacher gold accuracy, citation semantics or a release gate.",
        "total": len(cases), "submitted": len(rows), "passed": sum(c["passed"] for c in checks),
        "missing": sum(c["state"] == "MISSING" for c in checks),
        "contract_rejected": sum(c["state"] == "CONTRACT_REJECTED" for c in checks),
        "fallback": sum(c["state"] == "FALLBACK" for c in checks),
        "metrics": {
            "validated_candidate_coverage": ratio(len(valid), sum(not c["expected_error"] for c in cases)),
            "draft_label_agreement": ratio(sum(v[2]["draft_label_match"] for v in valid), len(valid)),
            "draft_false_acceptance": ratio(sum(v[1]["label"] == "CORRECT_REASONING" for v in negative_decisions), len(negative_decisions)),
            "draft_false_rejection": ratio(sum(v[1]["label"] != "CORRECT_REASONING" for v in positive_decisions), len(positive_decisions)),
            "positive_abstention": ratio(sum(v[1]["label"] == "UNSCORABLE" for v in positives), len(positives)),
            "candidate_abstention": ratio(sum(v[1]["label"] == "UNSCORABLE" for v in valid), len(valid)),
            "known_reference_ids_before_validation": ratio(sum(reference_checks), len(reference_checks)),
            "draft_required_reference_match": ratio(sum(v[2]["draft_evidence_match"] is True for v in valid),
                                                    sum(v[2]["draft_evidence_match"] is not None for v in valid)),
            "semantic_citation_accuracy": None,
        },
        "checks": checks,
    }


async def self_test():
    """Scripted responses prove plumbing only; suppress accuracy-like metrics."""
    cases = build_cases()
    rows = []
    for case in cases:
        label = case["expected_labels"][0] if case["expected_labels"] else "UNSCORABLE"
        abstain = label == "UNSCORABLE"
        output = {"label": label, "score": None if abstain else 1.0 if label == "CORRECT_REASONING" else .2,
                  "confidence": None if abstain else .9, "evidence_quality": None if abstain else .8,
                  "matched_rubric_items": case["required_criteria"] if not abstain else [],
                  "misconception_codes": [], "evidence_ids": [] if abstain else case["required_evidence"],
                  "next_action_recommendation": "HUMAN_REVIEW" if abstain else "RETRY_REASONING"}
        provider = FakeProvider([json.dumps(output, ensure_ascii=False)])
        result = await FeedbackService(provider).run("evaluator", case["payload"])
        rows.append({"case_id": case["id"], "input_digest": case["input_digest"],
                     "status": result.status, "error_code": result.error_code,
                     "raw_output": json.dumps(result.output, ensure_ascii=False) if result.status == "OK" else None,
                     "attempts": result.trace["attempts"]})
    report = compare_recorded({"suite_version": SUITE_VERSION, "suite_digest": suite_digest(cases),
        "prompt_version": PROMPT_VERSION, "schema_version": SCHEMA_VERSION,
        "origin": "RECORDED_UNVERIFIED", "responses": rows})
    report.update(origin="SELF_TEST", simulated=True, metrics=None,
                  scope="Scripted fixture/replay checks only; no model or semantic accuracy measurement.")
    return report
