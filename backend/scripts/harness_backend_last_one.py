"""Last approved synthetic request, same ledger, 128 tokens/180s/no retry.

Offline by default. The only real dispatch requires the explicit execute flag,
three unchanged prior reservations and a never-reused start marker.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
from types import SimpleNamespace
import uuid

from backend.config import ROOT
from backend.collaboration.contracts import CreateRunRequest, CreateTaskRequest
from backend.collaboration.database import create_collaboration_database, init_collaboration_database
from backend.collaboration.runtime import MockHarnessAdapter
from backend.collaboration.service import CollaborationService
from backend.collaboration.synthetic_budget import PROMPTS, SHORT_PROMPT, make_policy, task_request
from backend.scripts import collaboration_http_acceptance as local_http
from backend.scripts.editorial_data_audit import audit
from backend.scripts.harness_backend_acceptance import PREFIX, create_task, observation, wait_child_exit
from backend.scripts.harness_backend_remaining_two import seed, records, body
from backend.scripts.harness_synthetic_single_call import resolve_credential


def seed_three(directory):
    seed(directory)
    engine, factory = create_collaboration_database(f"sqlite:///{directory / 'collaboration.db'}")
    init_collaboration_database(engine)
    service = CollaborationService(factory, MockHarnessAdapter())
    task = service.create_task(CreateTaskRequest(**task_request()))["task"]["id"]
    run, _ = service.create_run(task, CreateRunRequest(prompt=PROMPTS["first"], manifest_version=1,
                               max_output_tokens=128, timeout_seconds=180), "remaining180:first")
    assert service.claim_next_run() == run["id"]
    service._complete_failure(run["id"], "FAILED", "DSH_OUTPUT_TOKEN_LIMIT")
    engine.dispose()
    (directory / "attempts" / "followup.json").write_text(json.dumps({
        "status": "DISPATCH_RESERVED", "scenario": "followup", "run_id": run["id"],
        "provider_fetch_attempts": 0, "fake_transport_calls": 0, "synthetic_seed_without_transport": True}), encoding="utf-8")


def preflight(directory):
    originals = records(directory / "collaboration.db")
    slots = {"first", "interrupted", "followup"}
    ledger = directory / "attempts"
    if len(originals) != 3 or {path.stem for path in ledger.glob("*.json")} != slots:
        raise RuntimeError("EXACT_THREE_PRIOR_ATTEMPTS_REQUIRED")
    preserved = {path: path.read_bytes() for path in [*ledger.glob("*.json"), *directory.glob("*policy.json")]}
    locks = {}
    for scenario in sorted(slots):
        raw = preserved[ledger / f"{scenario}.json"]
        entry = json.loads(raw)
        expected = ("FAILED", "DSH_OUTPUT_TOKEN_LIMIT") if scenario == "followup" else ("OUTCOME_UNKNOWN", "DSH_RUN_TIMEOUT")
        matching = [row for row in originals if row["id"] == entry["run_id"]]
        if (entry["scenario"] != scenario or entry["status"] != "DISPATCH_RESERVED" or len(matching) != 1
                or (matching[0]["status"], matching[0]["outcome_code"]) != expected):
            raise RuntimeError("PRIOR_LOCK_OR_TERMINAL_MISMATCH")
        locks[scenario] = {"sha256": hashlib.sha256(raw).hexdigest(), "run_id": entry["run_id"]}
    if len({entry["run_id"] for entry in locks.values()}) != 3:
        raise RuntimeError("DISTINCT_PRIOR_RUNS_REQUIRED")
    return originals, preserved, {"plan": "last_one_short_output_180s", "locks": locks}


def readback(server, environment, report, originals, new_result, task_id, request):
    server.stop()
    server.start(environment={key: value for key, value in environment.items() if key != "DEEPSEEK_API_KEY"})
    report["owned_backend_pids"].append(server.process.pid)
    for old in originals:
        found = server.poll(old["id"], old["status"])
        assert found["outcome_code"] == old["outcome_code"] and found["artifacts"] == []
    restored = server.poll(new_result["id"], new_result["status"])
    assert restored["outcome_code"] == new_result["outcome_code"] and restored["artifacts"] == new_result["artifacts"]
    code, replay = server.request("POST", f"{PREFIX}/tasks/{task_id}/runs", request, key="last-short:first")
    assert code == 200 and replay["id"] == new_result["id"]
    code, events = server.request("GET", f"{PREFIX}/runs/{new_result['id']}/events")
    assert code == 200 and "event:" in events
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    code, tail = server.request("GET", f"{PREFIX}/runs/{new_result['id']}/events", headers={"Last-Event-ID": str(ids[2])})
    assert code == 200 and all(int(line[4:]) > ids[2] for line in tail.splitlines() if line.startswith("id: "))
    code, _ = server.request("GET", f"{PREFIX}/tasks/{task_id}/handoff")
    assert code == 200
    report.update(credential_free_restart_read="PASS", idempotency_sse_handoff="PASS", originals_not_redispatched=True)
    # Spent permit rejects before child creation, even without a credential.
    denied_task = create_task(server)
    code, denied = server.request("POST", f"{PREFIX}/tasks/{denied_task}/runs", request, key="last-short:quota-denied")
    assert code == 201
    rejected = server.poll(denied["id"], "FAILED")
    assert rejected["outcome_code"] == "DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY"
    report["exhausted_budget_rejected_before_dispatch"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-approved-last-one", action="store_true")
    args = parser.parse_args()
    mode = "execute" if args.execute_approved_last_one else "offline"
    directory = ROOT / "output" / "harness-backend-20261015" / ("real" if mode == "execute" else f"last-short-offline-{uuid.uuid4()}")
    local_http.port_available(8001)
    if mode == "offline":
        directory.mkdir(parents=True)
        seed_three(directory)
    originals, preserved, permit = preflight(directory)
    backup = ROOT / "output" / "backups" / ("wenyan-before-harness-last-short-20261015.db" if mode == "execute" else "wenyan-before-harness-backend-20261015.db")
    if not backup.exists():
        raise RuntimeError("LEARNER_BACKUP_REQUIRED")
    with (directory / "last-short-started.json").open("x", encoding="utf-8") as file:
        json.dump(permit, file)
    policy = directory / "last-short-policy.json"
    with policy.open("x", encoding="utf-8") as file:
        json.dump(make_policy(mode, last_one=permit), file, ensure_ascii=False, indent=2)
    ledger = directory / "attempts"
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(8001, isolated=True)
    server.database = directory / "collaboration.db"
    report = {"status": "PREPARING", "mode": mode, "new_calls_budget": 1, "cumulative_calls_budget": 4,
              "max_output_tokens": 128, "timeout_seconds": 180, "automatic_retries": 0, "short_prompt": SHORT_PROMPT,
              "expected_output": "乙", "policy_file": str(policy), "shared_ledger": str(ledger),
              "learner_backup": str(backup), "followup_or_running_cancel_verified": False}
    report_file = directory / "last-short.json"
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    key = ""
    environment = {}
    started = time.monotonic()
    try:
        if mode == "execute":
            key, report["credential_source"] = resolve_credential(SimpleNamespace(allow_personal_credential=True,
                credential_file=Path(r"C:\Users\admin\.dsh\.credentials.yaml")))
        else:
            key = "synthetic-offline-not-a-real-key"
        environment = {"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                       "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(policy), "WENYAN_COLLABORATION_MAX_TOKENS": "128",
                       "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "180", "DEEPSEEK_API_KEY": key}
        server.start(environment=environment)
        report["owned_backend_pids"] = [server.process.pid]
        task = create_task(server)
        request = body(SHORT_PROMPT)
        code, run = server.request("POST", f"{PREFIX}/tasks/{task}/runs", request, key="last-short:first")
        assert code == 201
        report["run_id"] = run["id"]
        save()
        result = server.poll(run["id"], timeout=188)
        report["result"] = result
        report["candidate_matches"] = False
        if result["status"] == "WAITING_REVIEW":
            artifact = result["artifacts"][0]
            payload = artifact["payload"]
            assert artifact["review_status"] == "CANDIDATE" and payload["metadata"]["history_messages"] == 0
            assert payload["metadata"]["synthetic"] == (mode == "offline")
            assert payload["metadata"]["runtime_shutdown_graceful"] is True
            report["candidate_matches"] = payload["text"].strip() == "乙"
        save()
        transport_file = observation(run["id"])
        if transport_file.exists():
            report["transport"] = json.loads(transport_file.read_text(encoding="utf-8"))
            wait_child_exit(report["transport"]["child_pid"])
        readback(server, environment, report, originals, result, task, request)
        report["status"] = "PASS" if report["candidate_matches"] else "FAILED_OUTPUT_VALIDATION_NO_RETRY"
    except Exception as error:
        report.update(status="FAILED_NO_RETRY", error_type=type(error).__name__)
    finally:
        try:
            server.stop()
        finally:
            environment.pop("DEEPSEEK_API_KEY", None)
            key = ""
        attempts = [json.loads(path.read_text(encoding="utf-8")) for path in ledger.glob("*.json")]
        report.update(attempts=attempts, provider_fetch_attempts_total=sum(item["provider_fetch_attempts"] for item in attempts),
                      new_provider_fetch_attempts=sum(item["provider_fetch_attempts"] for item in attempts if item["scenario"] == "cancel"),
                      fake_transport_calls=sum(item["fake_transport_calls"] for item in attempts),
                      preserved_locks_and_policies_unchanged=all(path.read_bytes() == raw for path, raw in preserved.items()),
                      owned_backend_stopped=server.process is None or server.process.poll() is not None,
                      terminal_runs=records(server.database), learner_data_audit=audit(backup, ROOT / "data" / "wenyan.db"),
                      elapsed_seconds=round(time.monotonic() - started, 3))
        if report["status"] == "PASS" and (len(attempts) != 4 or not report["preserved_locks_and_policies_unchanged"]
                or report["new_provider_fetch_attempts"] != (1 if mode == "execute" else 0)):
            report["status"] = "FAILED_BUDGET_ACCOUNTING"
        save()
    print(json.dumps({name: report.get(name) for name in ("status", "error_type", "candidate_matches", "new_provider_fetch_attempts",
                     "provider_fetch_attempts_total", "fake_transport_calls", "preserved_locks_and_policies_unchanged", "owned_backend_stopped")}))
    print(str(report_file))


if __name__ == "__main__":
    main()
