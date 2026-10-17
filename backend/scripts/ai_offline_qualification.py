"""Large reproducible synthetic boundary run. No credentials, DB or live mode.

All providers are explicit in-memory FakeProvider instances. Passing this suite
does not measure DeepSeek semantics, teaching quality or production throughput.
"""
import argparse
import asyncio
from copy import deepcopy
import json
from time import monotonic

from backend.ai.calibration import compare_recorded, manifest
from backend.ai.calibration_cases import build_cases
from backend.ai.preview import PreviewRuntime
from backend.ai.providers import FakeProvider, ProviderError
from backend.ai.service import FeedbackService

VERSION = "offline-boundary-v1"


def candidate(**changes):
    return {"label": "CORRECT_REASONING", "score": 1.0, "confidence": .9,
            "evidence_quality": .9, "evidence_ids": ["e1"],
            "matched_rubric_items": ["cite", "relate", "limit"],
            "misconception_codes": [], "next_action_recommendation": "RETRY_REASONING", **changes}


def variants():
    """The outputs below are contract fixtures, not expected semantic answers."""
    encode = lambda value: json.dumps(value, ensure_ascii=False)
    good = encode(candidate())
    abstain = encode(candidate(label="UNSCORABLE", score=None, confidence=None,
        evidence_quality=None, evidence_ids=[], matched_rubric_items=[],
        next_action_recommendation="HUMAN_REVIEW"))
    rows = [
        ("valid-contract", [good], None, 1, "CORRECT_REASONING"),
        ("confidence-threshold", [encode(candidate(confidence=.65))], None, 1, "CORRECT_REASONING"),
        ("confidence-abstention", [encode(candidate(confidence=.64))], None, 1, "UNSCORABLE"),
        ("explicit-abstention", [abstain], None, 1, "UNSCORABLE"),
        ("single-repair", ["INVALID-PRIVATE-CANDIDATE", good], None, 2, "CORRECT_REASONING"),
    ]
    mutations = [
        ("unknown-evidence", {"evidence_ids": ["unknown"]}),
        ("unknown-criterion", {"matched_rubric_items": ["unknown"]}),
        ("duplicate-evidence", {"evidence_ids": ["e1", "e1"]}),
        ("duplicate-criterion-low-confidence", {"confidence": .64, "matched_rubric_items": ["cite", "cite"]}),
        ("duplicate-misconception-low-confidence", {"confidence": .64, "misconception_codes": ["MISSED_SUBJECT", "MISSED_SUBJECT"]}),
        ("boolean-score", {"score": True}),
        ("string-confidence", {"confidence": "0.9"}),
        ("negative-confidence", {"confidence": -.1}),
        ("over-confidence", {"confidence": 1.1}),
        ("missing-evidence", {"evidence_ids": []}),
        ("missing-criterion", {"matched_rubric_items": []}),
        ("incorrect-full-score", {"score": .5}),
        ("executable-action", {"next_action_recommendation": "COMPLETE_SESSION"}),
        ("extra-command", {"command": "award_points"}),
        ("abstention-with-score", {"label": "UNSCORABLE", "next_action_recommendation": "HUMAN_REVIEW"}),
        ("abstention-with-retry", {"label": "UNSCORABLE", "score": None, "evidence_quality": None, "matched_rubric_items": []}),
    ]
    for name, changes in mutations:
        raw = encode(candidate(**changes))
        rows.append((name, [raw, raw], "INVALID_OUTPUT", 2, "UNSCORABLE"))
    for name, raw in [("invalid-json", "NOT_JSON"), ("duplicate-key", '{"label":"UNSCORABLE","label":"CORRECT_REASONING"}'),
                      ("nonfinite-number", '{"confidence":NaN}'), ("json-array", "[]"),
                      ("oversized-response", "x" * 32_001)]:
        rows.append((name, [raw, raw], "INVALID_OUTPUT", 2, "UNSCORABLE"))
    for code in ("PROVIDER_TIMEOUT", "RATE_LIMITED", "INVALID_OUTPUT", "SAFETY_BLOCKED", "PROVIDER_UNAVAILABLE"):
        rows.append(("provider-" + code.lower(), [ProviderError(code), ProviderError(code)],
                     code, 2 if code == "INVALID_OUTPUT" else 1, "UNSCORABLE"))
    rows.append(("unexpected-private-error", [RuntimeError("PRIVATE-VENDOR-ERROR")],
                 "PROVIDER_UNAVAILABLE", 1, "UNSCORABLE"))
    return rows


async def boundary_matrix(rounds):
    total = passed = calls = 0
    failures = []
    scenarios = variants()
    for repetition in range(rounds):
        for case in build_cases():
            if case["expected_error"]:
                scenarios_for_case = [("known-attack", [], "SAFETY_BLOCKED", 0, "UNSCORABLE")]
            else:
                scenarios_for_case = scenarios
            for name, outputs, error, attempts, label in scenarios_for_case:
                provider = FakeProvider(outputs)
                original = deepcopy(case["payload"])
                result = await FeedbackService(provider).run("evaluator", case["payload"])
                total += 1
                calls += len(provider.calls)
                safe = not result.may_update_learning and result.simulated
                wire_safe = all(json.loads(call.data_json) == original for call in provider.calls)
                repair_safe = all(call.repair == bool(index) and
                    "INVALID-PRIVATE-CANDIDATE" not in call.system for index, call in enumerate(provider.calls))
                trace_safe = not any(secret in json.dumps(result.trace) for secret in
                                     (original["student_reason"], "PRIVATE-VENDOR-ERROR"))
                expected = (result.status == ("FALLBACK" if error else "OK") and
                    result.error_code == error and result.trace["attempts"] == attempts and
                    result.output["label"] == label and len(provider.calls) == attempts)
                if expected and safe and wire_safe and repair_safe and trace_safe and case["payload"] == original:
                    passed += 1
                else:
                    failures.append({"round": repetition + 1, "case_id": case["id"], "variant": name})
    return {"total": total, "passed": passed, "simulated_provider_attempts": calls,
            "variant_count": len(scenarios), "failures": failures}


async def runtime_checks():
    checks = []
    def check(name, condition):
        checks.append({"name": name, "passed": bool(condition)})

    payload = build_cases()[0]["payload"]
    clock = [0.0]
    providers = []
    def factory(_):
        provider = FakeProvider()
        providers.append(provider)
        return provider
    runtime = PreviewRuntime(factory, clock=lambda: clock[0])
    for index in range(80):
        value = await runtime.run("synthetic-a", f"synthetic-{index}", 1, payload)
        check("initial-uncached-" + str(index), not value["cached"] and not value["may_update_learning"])
    check("cache-capacity-64", len(runtime.cache) == 64 and len(providers[0].calls) == 80)
    for index in range(16, 80):
        check("cache-hit-" + str(index), (await runtime.run("synthetic-a", f"synthetic-{index}", 1, payload))["cached"])
    check("hits-do-not-call", len(providers[0].calls) == 80)
    value = await runtime.run("synthetic-a", "synthetic-79", 1, payload)
    value["summary"] = "MUTATED"
    value["matched_criteria"].append("MUTATED")
    fresh = await runtime.run("synthetic-a", "synthetic-79", 1, payload)
    check("cache-copy-isolation", fresh["summary"] != "MUTATED" and "MUTATED" not in fresh["matched_criteria"])
    evicted = await runtime.run("synthetic-a", "synthetic-0", 1, payload)
    check("evicted-request-is-new", not evicted["cached"] and len(providers[0].calls) == 81)
    check("version-change-is-new", not (await runtime.run("synthetic-a", "synthetic-0", 2, payload))["cached"])
    changed = deepcopy(payload)
    changed["student_reason"] += "不同的合成理由。"
    check("payload-change-is-new", not (await runtime.run("synthetic-a", "synthetic-0", 2, changed))["cached"])
    clock[0] = 600.0
    check("exact-ttl-expiry", not (await runtime.run("synthetic-a", "synthetic-79", 1, payload))["cached"] and len(runtime.cache) == 1)
    await runtime.run("synthetic-b", "synthetic-79", 1, payload)
    check("settings-change-clears-cache", len(providers) == 2 and len(runtime.cache) == 1)

    entered, release = asyncio.Event(), asyncio.Event()
    class Held(FakeProvider):
        async def generate_structured(self, request):
            entered.set()
            await release.wait()
            return await super().generate_structured(request)
    held = Held()
    runtime = PreviewRuntime(lambda _: held)
    first = asyncio.create_task(runtime.run("synthetic-a", "cancelled", 1, payload))
    await asyncio.wait_for(entered.wait(), 1)
    async def busy(index):
        try:
            await runtime.run("synthetic-a", f"competing-{index}", 1, payload)
        except ValueError as error:
            return str(error) == "AI_FEEDBACK_BUSY"
        return False
    contention = await asyncio.gather(*(busy(index) for index in range(40)))
    check("40-concurrent-requests-busy", all(contention))
    try:
        await runtime.run("synthetic-b", "new-config", 1, payload)
        blocked = False
    except ValueError as error:
        blocked = str(error) == "AI_FEEDBACK_BUSY"
    check("configuration-change-while-busy-blocked", blocked)
    first.cancel()
    try:
        await first
        cancelled = False
    except asyncio.CancelledError:
        cancelled = True
    check("cancellation-propagates-without-cache", cancelled and not runtime.running and not runtime.cache)
    release.set()
    check("runtime-recovers-after-cancel", (await runtime.run("synthetic-a", "cancelled", 1, payload))["status"] == "OK")

    now = [0.0]
    breaker_provider = FakeProvider([ProviderError("PROVIDER_UNAVAILABLE"), ProviderError("PROVIDER_UNAVAILABLE")])
    service = FeedbackService(breaker_provider, clock=lambda: now[0])
    await service.run("evaluator", payload)
    await service.run("evaluator", payload)
    blocked_results = await asyncio.gather(*(service.run("evaluator", payload) for _ in range(40)))
    check("40-open-breaker-requests-zero-attempts", all(r.trace["attempts"] == 0 for r in blocked_results) and len(breaker_provider.calls) == 2)
    now[0] = 30.0
    check("breaker-recovers-at-cooldown", (await service.run("evaluator", payload)).status == "OK" and service.failures == 0)

    class Timed(FakeProvider):
        async def generate_structured(self, request):
            self.calls.append(request)
            await asyncio.sleep(1)
    service = FeedbackService(Timed(), timeout_seconds=.01)
    value = await service.run("evaluator", payload)
    check("timeout-is-fallback", value.error_code == "PROVIDER_TIMEOUT" and value.trace["attempts"] == 1)
    return {"total": len(checks), "passed": sum(c["passed"] for c in checks), "checks": checks}


def recorded_checks():
    """Batch rejection and coverage bookkeeping; no draft accuracy judgment."""
    info = manifest()
    header = {key: info[key] for key in ("suite_version", "suite_digest", "prompt_version", "schema_version")}
    cases = build_cases()
    rows = [{"case_id": c["id"], "input_digest": c["input_digest"], "status": "FALLBACK",
             "error_code": "SAFETY_BLOCKED" if c["expected_error"] else "PROVIDER_TIMEOUT",
             "raw_output": None, "attempts": 0 if c["expected_error"] else 1} for c in cases]
    def batch(responses):
        return {**header, "origin": "RECORDED_UNVERIFIED", "responses": responses}
    checks = []
    for count in range(41):
        report = compare_recorded(batch(rows[:count]))
        checks.append({"name": "partial-coverage-" + str(count), "passed":
            report["submitted"] == count and report["missing"] == 40 - count and
            not report["semantic_accuracy_verified"] and not report["live_ai_release_gate_satisfied"]})
    for index in range(40):
        altered = deepcopy(rows)
        altered[index]["input_digest"] = "0" * 64
        try:
            compare_recorded(batch(altered))
            rejected = False
        except ValueError as error:
            rejected = str(error) == "CALIBRATION_RECORD_INVALID"
        checks.append({"name": "input-binding-" + str(index), "passed": rejected})
    return {"total": len(checks), "passed": sum(c["passed"] for c in checks), "checks": checks}


async def run_suite(rounds=3):
    if type(rounds) is not int or not 1 <= rounds <= 10:
        raise ValueError("OFFLINE_QUALIFICATION_POLICY_INVALID")
    started = monotonic()
    sections = {"boundary_matrix": await boundary_matrix(rounds),
                "runtime": await runtime_checks(), "recorded_batches": recorded_checks()}
    total = sum(section["total"] for section in sections.values())
    passed = sum(section["passed"] for section in sections.values())
    return {"suite_version": VERSION, "origin": "OFFLINE_SYNTHETIC", "rounds": rounds,
            "total": total, "passed": passed, "status": "PASS" if passed == total else "FAIL",
            "elapsed_ms": round((monotonic() - started) * 1000), "external_call_attempted": False,
            "semantic_accuracy_verified": False, "may_update_learning": False,
            "live_ai_release_gate_satisfied": False, "sections": sections}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Synthetic AI boundary qualification, no live model calls")
    parser.add_argument("--rounds", type=int, choices=range(1, 11), default=3)
    args = parser.parse_args(argv)
    result = asyncio.run(run_suite(args.rounds))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
