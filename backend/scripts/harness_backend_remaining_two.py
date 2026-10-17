"""Approved last-two/180-second acceptance. Default is offline, never retries.

Uses the original ledger; immutable first/interrupted locks are prerequisites.
Second call tests followup and backend cancellation AFTER model completion,
before candidate persistence. It does not test provider inference cancellation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from types import SimpleNamespace
import uuid

from backend.config import ROOT
from backend.collaboration.contracts import CreateRunRequest, CreateTaskRequest
from backend.collaboration.database import create_collaboration_database, init_collaboration_database
from backend.collaboration.runtime import MockHarnessAdapter
from backend.collaboration.service import CollaborationService
from backend.collaboration.synthetic_budget import CANDIDATE, PROMPTS, QUEUED_CANCEL_PROMPT, make_policy, load_policy, task_request
from backend.scripts import collaboration_http_acceptance as local_http
from backend.scripts.editorial_data_audit import audit
from backend.scripts.harness_backend_acceptance import PREFIX, create_task, observation, wait_child_exit
from backend.scripts.harness_synthetic_single_call import resolve_credential


def seed(directory):
    engine, factory = create_collaboration_database(f"sqlite:///{directory / 'collaboration.db'}")
    init_collaboration_database(engine)
    service = CollaborationService(factory, MockHarnessAdapter())
    (directory / "attempts").mkdir()
    for scenario in ("first", "interrupted"):
        task = service.create_task(CreateTaskRequest(**task_request()))["task"]["id"]
        run, _ = service.create_run(task, CreateRunRequest(prompt=PROMPTS[scenario], manifest_version=1,
                                  max_output_tokens=128, timeout_seconds=60), "closure:" + scenario)
        assert service.claim_next_run() == run["id"]
        service._complete_failure(run["id"], "OUTCOME_UNKNOWN", "DSH_RUN_TIMEOUT")
        (directory / "attempts" / f"{scenario}.json").write_text(json.dumps({
            "status": "DISPATCH_RESERVED", "scenario": scenario, "run_id": run["id"],
            "provider_fetch_attempts": 0, "fake_transport_calls": 0, "synthetic_seed_without_transport": True}), encoding="utf-8")
    engine.dispose()
    (directory / "budget-policy.json").write_text(json.dumps(make_policy()), encoding="utf-8")


def records(database):
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        return [dict(zip(("id", "task_id", "status", "outcome_code"), row)) for row in db.execute(
            "SELECT id,task_id,status,outcome_code FROM collaboration_runs ORDER BY created_at")]


def body(prompt):
    return {"prompt": prompt, "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 180}


def readback():
    directory = ROOT / "output" / "harness-backend-20261015" / "real"
    expected = records(directory / "collaboration.db")
    if any(row["status"] not in local_http.TERMINAL for row in expected):
        raise RuntimeError("READBACK_REQUIRES_ALL_TERMINAL")
    policy = directory / "remaining-two-180-policy.json"
    preserved = {path: path.read_bytes() for path in [*directory.glob("*policy.json"), *(directory / "attempts").glob("*.json")]}
    report = {"status": "PREPARING", "credential_loaded": False, "new_provider_calls": 0}
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(8001, isolated=True)
    server.database = directory / "collaboration.db"
    try:
        server.start(environment={"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                     "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(policy), "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "180"})
        report["owned_backend_pid"] = server.process.pid
        for row in expected:
            found = server.poll(row["id"], row["status"])
            assert found["outcome_code"] == row["outcome_code"] and found["artifacts"] == []
            code, events = server.request("GET", f"{PREFIX}/runs/{row['id']}/events")
            assert code == 200 and "event:" in events
            code, handoff = server.request("GET", f"{PREFIX}/tasks/{row['task_id']}/handoff")
            assert code == 200
        first = expected[0]
        code, replay = server.request("POST", f"{PREFIX}/tasks/{first['task_id']}/runs",
                                     {**body(PROMPTS["first"]), "timeout_seconds": 60}, key="closure:first")
        assert code == 200 and replay["id"] == first["id"] and replay["status"] == "OUTCOME_UNKNOWN"
        report.update(status="PASS", terminal_runs=expected, original_not_redispatched=True)
    finally:
        server.stop()
        report["preserved_locks_and_policies_unchanged"] = all(path.read_bytes() == raw for path, raw in preserved.items())
        assert {path.name for path in (directory / "attempts").glob("*.json")} == {"first.json", "interrupted.json", "followup.json"}
        report["owned_backend_stopped"] = server.process is None or server.process.poll() is not None
        path = directory / "readback-after-180.json"
        with path.open("x", encoding="utf-8") as file:
            json.dump(report, file, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False))


def suite(server, environment, report, save, originals):
    server.start(environment=environment)
    report["owned_backend_pids"] = [server.process.pid]
    task = create_task(server)
    first_body = body(PROMPTS["first"])
    code, first = server.request("POST", f"{PREFIX}/tasks/{task}/runs", first_body, key="remaining180:first")
    assert code == 201
    report["new_task_run_id"] = first["id"]
    save()
    first_done = server.poll(first["id"], timeout=188)
    report["new_task"] = first_done
    save()
    assert first_done["status"] == "WAITING_REVIEW"
    artifact = first_done["artifacts"][0]
    payload = artifact["payload"]
    assert json.loads(payload["text"]) == CANDIDATE
    assert payload["metadata"]["history_messages"] == 0
    assert payload["metadata"]["synthetic"] == (report["mode"] == "offline")
    code, events = server.request("GET", f"{PREFIX}/runs/{first['id']}/events")
    assert code == 200 and "event: run.completed" in events and "event: runtime.turn_completed" in events
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    code, tail = server.request("GET", f"{PREFIX}/runs/{first['id']}/events", headers={"Last-Event-ID": str(ids[2])})
    assert code == 200 and all(int(line[4:]) > ids[2] for line in tail.splitlines() if line.startswith("id: "))
    code, duplicate = server.request("POST", f"{PREFIX}/tasks/{task}/runs", first_body, key="remaining180:first")
    assert code == 200 and duplicate["id"] == first["id"]
    report["result_sse_idempotency"] = "PASS"
    save()
    server.stop()
    server.start(environment=environment)
    report["owned_backend_pids"].append(server.process.pid)
    assert server.poll(first["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == artifact["id"]
    report["normal_restart_read"] = "PASS"
    follow_body = {"content": PROMPTS["followup"], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 180}
    code, follow = server.request("POST", f"{PREFIX}/tasks/{task}/messages", follow_body, key="remaining180:followup")
    assert code == 202
    follow_id = follow["run"]["id"]
    report["followup_run_id"] = follow_id
    save()
    checkpoint = observation(follow_id).parent / "completion-checkpoint.json"
    deadline = time.monotonic() + 188
    while not checkpoint.exists():
        code, current = server.request("GET", f"{PREFIX}/runs/{follow_id}")
        assert code == 200 and current["status"] not in local_http.TERMINAL
        if time.monotonic() >= deadline:
            raise RuntimeError("COMPLETION_CHECKPOINT_TIMEOUT")
        time.sleep(0.05)
    evidence = json.loads(checkpoint.read_text(encoding="utf-8"))
    assert evidence["candidate"] == CANDIDATE and evidence["metadata"]["history_messages"] == 2
    assert evidence["metadata"]["runtime_shutdown_graceful"] is True
    current = server.poll(follow_id, "RUNNING")
    assert current["parent_run_id"] == first["id"] and current["harness_session_id"] != first_done["harness_session_id"]
    queued_body = {**follow_body, "content": QUEUED_CANCEL_PROMPT}
    code, queued = server.request("POST", f"{PREFIX}/tasks/{task}/messages", queued_body, key="remaining180:queued")
    assert code == 202 and queued["run"]["status"] == "QUEUED"
    code, queued_done = server.request("POST", f"{PREFIX}/runs/{queued['run']['id']}/cancel")
    assert code == 200 and queued_done["outcome_code"] == "CANCELLED_BEFORE_START"
    code, _ = server.request("POST", f"{PREFIX}/runs/{follow_id}/cancel")
    assert code == 200
    cancelled = server.poll(follow_id, "CANCELLED")
    assert cancelled["artifacts"] == [] and cancelled["outcome_code"] == "CANCELLED_AFTER_START"
    transport = json.loads(observation(follow_id).read_text(encoding="utf-8"))
    wait_child_exit(transport["child_pid"])
    code, duplicate = server.request("POST", f"{PREFIX}/tasks/{task}/messages", follow_body, key="remaining180:followup")
    assert code == 200 and duplicate["run"]["id"] == follow_id
    report.update(followup_checkpoint=evidence, cancelled_followup=cancelled, queued_cancel=queued_done,
                  provider_mid_inference_cancel_verified=False, followup_saved_candidate=False)
    save()
    server.stop()
    # Restart/readback contains NO credential and no pending jobs; no fetch.
    read_environment = {key: value for key, value in environment.items() if key != "DEEPSEEK_API_KEY"}
    server.start(environment=read_environment)
    report["owned_backend_pids"].append(server.process.pid)
    assert server.poll(first["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == artifact["id"]
    assert server.poll(follow_id, "CANCELLED")["artifacts"] == []
    for old in originals:
        assert server.poll(old["id"], "OUTCOME_UNKNOWN")["artifacts"] == []
    original = originals[0]
    old_body = {**body(PROMPTS["first"]), "timeout_seconds": 60}
    code, replay = server.request("POST", f"{PREFIX}/tasks/{original['task_id']}/runs", old_body, key="closure:first")
    assert code == 200 and replay["id"] == original["id"] and replay["status"] == "OUTCOME_UNKNOWN"
    denied_task = create_task(server)
    code, denied = server.request("POST", f"{PREFIX}/tasks/{denied_task}/runs", first_body, key="remaining180:denied")
    assert code == 201
    rejected = server.poll(denied["id"], "FAILED")
    assert rejected["outcome_code"] == "DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY"
    report.update(restart_reads="PASS", original_not_redispatched=True, budget_denial=rejected)
    save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-approved-remaining-two", action="store_true")
    parser.add_argument("--readback-only", action="store_true")
    args = parser.parse_args()
    if args.readback_only:
        if args.execute_approved_remaining_two:
            raise RuntimeError("READBACK_CANNOT_EXECUTE")
        return readback()
    mode = "execute" if args.execute_approved_remaining_two else "offline"
    directory = ROOT / "output" / "harness-backend-20261015" / ("real" if mode == "execute" else f"remaining180-offline-{uuid.uuid4()}")
    local_http.port_available(8001)
    if mode == "offline":
        directory.mkdir(parents=True)
        seed(directory)
    originals = records(directory / "collaboration.db")
    if len(originals) != 2 or any(row["status"] != "OUTCOME_UNKNOWN" or row["outcome_code"] != "DSH_RUN_TIMEOUT" for row in originals):
        raise RuntimeError("EXACT_TWO_UNKNOWN_REQUIRED")
    ledger = directory / "attempts"
    if {path.name for path in ledger.glob("*.json")} != {"first.json", "interrupted.json"}:
        raise RuntimeError("EXACT_TWO_UNSPENT_REQUIRED")
    preserved = {path: path.read_bytes() for path in [*ledger.glob("*.json"), *directory.glob("*policy.json")]}
    locks = {}
    for scenario in ("first", "interrupted"):
        raw = preserved[ledger / f"{scenario}.json"]
        entry = json.loads(raw)
        if entry["scenario"] != scenario or entry["status"] != "DISPATCH_RESERVED" or entry["run_id"] not in {row["id"] for row in originals}:
            raise RuntimeError("OLD_LOCK_MISMATCH")
        locks[scenario] = {"sha256": hashlib.sha256(raw).hexdigest(), "run_id": entry["run_id"]}
    backup = ROOT / "output" / "backups" / ("wenyan-before-harness-180s-20261015.db" if mode == "execute" else "wenyan-before-harness-backend-20261015.db")
    if not backup.exists():
        raise RuntimeError("LEARNER_BACKUP_REQUIRED")
    permit = {"plan": "remaining_two_180s", "locks": locks}
    with (directory / "remaining-two-180-started.json").open("x", encoding="utf-8") as file:
        json.dump(permit, file)
    policy_file = directory / "remaining-two-180-policy.json"
    with policy_file.open("x", encoding="utf-8") as file:
        json.dump(make_policy(mode, remaining_two=permit), file, ensure_ascii=False, indent=2)
    load_policy(policy_file)
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(8001, isolated=True)
    server.database = directory / "collaboration.db"
    report = {"status": "PREPARING", "mode": mode, "new_calls_budget": 2, "cumulative_calls_budget": 4,
              "max_output_tokens_per_call": 128, "timeout_seconds_per_call": 180, "automatic_retries": 0,
              "originals": originals, "policy_file": str(policy_file), "shared_ledger": str(ledger)}
    report_file = directory / "remaining-two-180.json"
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    key = ""
    environment = {}
    started = time.monotonic()
    try:
        key = resolve_credential(SimpleNamespace(allow_personal_credential=True,
              credential_file=Path(r"C:\Users\admin\.dsh\.credentials.yaml")))[0] if mode == "execute" else "synthetic-offline-not-a-real-key"
        environment = {"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                       "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(policy_file), "WENYAN_COLLABORATION_MAX_TOKENS": "128",
                       "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "180", "DEEPSEEK_API_KEY": key}
        save()
        suite(server, environment, report, save, originals)
        report["status"] = "PASS"
    except Exception as error:
        report.update(status="FAILED_NO_RETRY", error_type=type(error).__name__)
    finally:
        server.stop()
        environment.pop("DEEPSEEK_API_KEY", None)
        key = ""
        attempts = [json.loads(path.read_text(encoding="utf-8")) for path in ledger.glob("*.json")]
        report.update(attempts=attempts, provider_fetch_attempts_total=sum(item["provider_fetch_attempts"] for item in attempts),
                      new_provider_fetch_attempts=sum(item["provider_fetch_attempts"] for item in attempts if item["scenario"] in {"followup", "cancel"}),
                      fake_transport_calls=sum(item["fake_transport_calls"] for item in attempts),
                      preserved_locks_and_policies_unchanged=all(path.read_bytes() == raw for path, raw in preserved.items()),
                      owned_backend_stopped=server.process is None or server.process.poll() is not None,
                      terminal_runs=records(server.database), learner_data_audit=audit(backup, ROOT / "data" / "wenyan.db"),
                      elapsed_seconds=round(time.monotonic() - started, 3))
        if report["status"] == "PASS" and (len(attempts) != 4 or not report["preserved_locks_and_policies_unchanged"]
                or report["new_provider_fetch_attempts"] != (2 if mode == "execute" else 0)):
            report["status"] = "FAILED_BUDGET_ACCOUNTING"
        save()
    print(json.dumps({name: report.get(name) for name in ("status", "error_type", "new_provider_fetch_attempts", "provider_fetch_attempts_total",
                     "fake_transport_calls", "preserved_locks_and_policies_unchanged", "owned_backend_stopped")}))
    print(str(report_file))


if __name__ == "__main__":
    main()
