"""Finish the explicitly approved remaining-three plan using the SAME ledger.

Default: entirely synthetic transport and an isolated seeded unknown record.
Execute: requires the preserved real timeout, unchanged original lock/policy,
exactly one previous attempt, and a never-before-used continuation marker.
No retry of the unknown run and no paid crash-injection sample.
"""
from __future__ import annotations

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
from backend.collaboration.synthetic_budget import PROMPTS, QUEUED_CANCEL_PROMPT, load_policy, make_policy, task_request
from backend.scripts import collaboration_http_acceptance as local_http
from backend.scripts.editorial_data_audit import audit
from backend.scripts.harness_backend_acceptance import PREFIX, completed, create_run, create_task, wait_child_exit, wait_held
from backend.scripts.harness_synthetic_single_call import resolve_credential


def seed_offline(directory):
    """An explicitly labelled test fixture, never claimed to be a model call."""
    engine, factory = create_collaboration_database(f"sqlite:///{directory / 'collaboration.db'}")
    init_collaboration_database(engine)
    service = CollaborationService(factory, MockHarnessAdapter())
    task_id = service.create_task(CreateTaskRequest(**task_request()))["task"]["id"]
    run, _ = service.create_run(task_id, CreateRunRequest(prompt=PROMPTS["first"], manifest_version=1,
                                max_output_tokens=128, timeout_seconds=60), "closure:first")
    assert service.claim_next_run() == run["id"]
    service._complete_failure(run["id"], "OUTCOME_UNKNOWN", "DSH_RUN_TIMEOUT")
    engine.dispose()
    (directory / "attempts").mkdir()
    (directory / "attempts" / "first.json").write_text(json.dumps({"status": "DISPATCH_RESERVED", "scenario": "first",
        "run_id": run["id"], "provider_fetch_attempts": 0, "fake_transport_calls": 0,
        "synthetic_seed_without_transport": True}), encoding="utf-8")
    (directory / "budget-policy.json").write_text(json.dumps(make_policy()), encoding="utf-8")


def original_unknown(directory):
    with sqlite3.connect((directory / "collaboration.db").resolve().as_uri() + "?mode=ro", uri=True) as db:
        records = db.execute("SELECT id,task_id,status,outcome_code FROM collaboration_runs").fetchall()
        if len(records) != 1 or records[0][2:] != ("OUTCOME_UNKNOWN", "DSH_RUN_TIMEOUT"):
            raise RuntimeError("CONTINUATION_REQUIRES_EXACT_ORIGINAL_UNKNOWN")
        return records[0][0], records[0][1]


def run_remaining(server, environment, report, save, old_run, old_task):
    synthetic = report["mode"] == "offline"
    server.start(environment=environment)
    report["owned_backend_pids"] = [server.process.pid]
    old = server.poll(old_run, "OUTCOME_UNKNOWN")
    assert old["outcome_code"] == "DSH_RUN_TIMEOUT" and old["artifacts"] == []
    report["original_unknown"] = old
    main_task = create_task(server)
    assert main_task != old_task
    # Reuse the unspent interrupted SLOT as an independent fresh task. The
    # actual timeout already supplies the exception/recovery sample; the new
    # grant explicitly removes this slot's crash barrier, never its quota lock.
    first, first_body = create_run(server, main_task, "interrupted")
    first_done = completed(server, first["id"], synthetic)
    assert first_done["id"] != old_run
    assert first_done["artifacts"][0]["payload"]["metadata"]["history_messages"] == 0
    report["new_task"] = first_done
    save()
    code, replay = server.request("POST", f"{PREFIX}/tasks/{main_task}/runs", first_body, key="closure:interrupted")
    assert code == 200 and replay["id"] == first["id"]
    code, events = server.request("GET", f"{PREFIX}/runs/{first['id']}/events")
    assert code == 200 and "event: run.completed" in events and "event: runtime.turn_completed" in events
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    code, tail = server.request("GET", f"{PREFIX}/runs/{first['id']}/events", headers={"Last-Event-ID": str(ids[2])})
    assert code == 200 and all(int(line[4:]) > ids[2] for line in tail.splitlines() if line.startswith("id: "))
    report["result_and_sse_reads"] = "PASS"
    server.stop()
    server.start(environment=environment)
    report["owned_backend_pids"].append(server.process.pid)
    assert server.poll(first["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == first_done["artifacts"][0]["id"]
    assert server.poll(old_run, "OUTCOME_UNKNOWN")["artifacts"] == []
    report["normal_restart_read"] = "PASS"
    follow_body = {"content": PROMPTS["followup"], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, follow = server.request("POST", f"{PREFIX}/tasks/{main_task}/messages", follow_body, key="closure:followup")
    assert code == 202
    follow_done = completed(server, follow["run"]["id"], synthetic)
    assert follow_done["parent_run_id"] == first["id"]
    assert follow_done["artifacts"][0]["payload"]["metadata"]["history_messages"] == 2
    assert follow_done["harness_session_id"] != first_done["harness_session_id"]
    code, duplicate = server.request("POST", f"{PREFIX}/tasks/{main_task}/messages", follow_body, key="closure:followup")
    assert code == 200 and duplicate["run"]["id"] == follow_done["id"]
    report["followup"] = follow_done
    save()
    cancel_task = create_task(server)
    active, _ = create_run(server, cancel_task, "cancel")
    evidence = wait_held(server, active["id"])
    queued_body = {"content": QUEUED_CANCEL_PROMPT, "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, queued = server.request("POST", f"{PREFIX}/tasks/{cancel_task}/messages", queued_body, key="closure:queued-cancel")
    assert code == 202 and queued["run"]["status"] == "QUEUED"
    code, queued_done = server.request("POST", f"{PREFIX}/runs/{queued['run']['id']}/cancel")
    assert code == 200 and queued_done["outcome_code"] == "CANCELLED_BEFORE_START"
    code, _ = server.request("POST", f"{PREFIX}/runs/{active['id']}/cancel")
    assert code == 200
    cancelled = server.poll(active["id"], "CANCELLED")
    assert cancelled["artifacts"] == []
    wait_child_exit(evidence["child_pid"])
    report["running_cancel"] = {"run": cancelled, "provider_headers_before_cancel": evidence, "owned_child_exited": True,
                                 "provider_stop_or_billing_not_guaranteed": True}
    report["queued_cancel"] = queued_done
    save()
    server.stop()
    server.start(environment=environment)
    report["owned_backend_pids"].append(server.process.pid)
    assert server.poll(old_run, "OUTCOME_UNKNOWN")["outcome_code"] == "DSH_RUN_TIMEOUT"
    assert server.poll(active["id"], "CANCELLED")["artifacts"] == []
    assert server.poll(first["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == first_done["artifacts"][0]["id"]
    assert server.poll(follow_done["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == follow_done["artifacts"][0]["id"]
    report["terminal_states_after_restart"] = "PASS"
    original_body = {"prompt": PROMPTS["first"], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, replay = server.request("POST", f"{PREFIX}/tasks/{old_task}/runs", original_body, key="closure:first")
    assert code == 200 and replay["id"] == old_run and replay["status"] == "OUTCOME_UNKNOWN"
    denied_task = create_task(server)
    denied, _ = create_run(server, denied_task, "interrupted")
    rejected = server.poll(denied["id"], "FAILED")
    assert rejected["outcome_code"] == "DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY"
    report["budget_denial"] = rejected
    report["original_run_not_redispatched"] = True
    save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-approved-remaining-three", action="store_true")
    args = parser.parse_args()
    mode = "execute" if args.execute_approved_remaining_three else "offline"
    base = ROOT / "output" / "harness-backend-20261015"
    directory = base / ("real" if mode == "execute" else f"continuation-offline-{uuid.uuid4()}")
    local_http.port_available(8001)
    if mode == "offline":
        directory.mkdir(parents=True)
        seed_offline(directory)
    old_run, old_task = original_unknown(directory)
    policy_file = directory / "budget-policy.json"
    original_policy = policy_file.read_bytes()
    policy, _ = load_policy(policy_file)
    if policy != make_policy(mode) or {path.name for path in (directory / "attempts").glob("*.json")} != {"first.json"}:
        raise RuntimeError("CONTINUATION_REQUIRES_EXACT_UNSPENT_THREE")
    first_file = directory / "attempts" / "first.json"
    first_bytes = first_file.read_bytes()
    first_entry = json.loads(first_bytes)
    if first_entry["run_id"] != old_run or first_entry["scenario"] != "first":
        raise RuntimeError("CONTINUATION_ORIGINAL_LOCK_MISMATCH")
    # Exclusive start marker is never removed, including on preflight failure.
    with (directory / "continuation-started.json").open("x", encoding="utf-8") as marker:
        json.dump({"plan": "timeout_recovery_remaining_three", "original_run_id": old_run}, marker)
    continuation = {"plan": "timeout_recovery_remaining_three", "original_run_id": old_run,
                    "first_attempt_sha256": hashlib.sha256(first_bytes).hexdigest()}
    new_policy_file = directory / "continuation-policy.json"
    with new_policy_file.open("x", encoding="utf-8") as policy_output:
        json.dump(make_policy(mode, continuation=continuation), policy_output, ensure_ascii=False, indent=2)
    backup = ROOT / "output" / "backups" / "wenyan-before-harness-continuation-20261015.db"
    if not backup.exists():
        if mode == "execute":
            raise RuntimeError("FRESH_LEARNER_BACKUP_REQUIRED")
        backup = ROOT / "output" / "backups" / "wenyan-before-harness-backend-20261015.db"
    report = {"status": "PREPARING", "mode": mode, "approved_plan": continuation["plan"],
              "new_calls_budget": 3, "cumulative_calls_budget": 4, "max_output_tokens_per_call": 128,
              "timeout_seconds_per_call": 60, "automatic_retries": 0, "additional_paid_crash_sample": False,
              "policy_file": str(new_policy_file), "shared_ledger": str(directory / "attempts")}
    report["learner_backup"] = str(backup)
    report_file = directory / "continuation.json"
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(8001, isolated=True)
    server.database = directory / "collaboration.db"
    key = ""
    environment = {}
    started = time.monotonic()
    try:
        if mode == "execute":
            key, _ = resolve_credential(SimpleNamespace(allow_personal_credential=True,
                       credential_file=Path(r"C:\Users\admin\.dsh\.credentials.yaml")))
        else:
            key = "synthetic-offline-not-a-real-key"
        environment = {"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                       "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(new_policy_file), "WENYAN_COLLABORATION_MAX_TOKENS": "128",
                       "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "60", "DEEPSEEK_API_KEY": key}
        save()
        run_remaining(server, environment, report, save, old_run, old_task)
        report["status"] = "PASS"
    except Exception as error:
        report.update(status="FAILED_NO_RETRY", error_type=type(error).__name__)
    finally:
        try:
            server.stop()
        finally:
            environment.pop("DEEPSEEK_API_KEY", None)
            key = ""
        attempts = [json.loads(path.read_text(encoding="utf-8")) for path in (directory / "attempts").glob("*.json")]
        report["attempts"] = attempts
        report["provider_fetch_attempts_total"] = sum(item["provider_fetch_attempts"] for item in attempts)
        report["new_provider_fetch_attempts"] = report["provider_fetch_attempts_total"] - first_entry["provider_fetch_attempts"]
        report["fake_transport_calls"] = sum(item["fake_transport_calls"] for item in attempts)
        report["original_lock_unchanged"] = first_file.read_bytes() == first_bytes
        report["original_policy_unchanged"] = policy_file.read_bytes() == original_policy
        report["owned_backend_stopped"] = server.process is None or server.process.poll() is not None
        with sqlite3.connect(server.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
            report["terminal_runs"] = [dict(zip(("run_id", "status", "outcome_code"), row)) for row in db.execute(
                "SELECT id,status,outcome_code FROM collaboration_runs ORDER BY created_at")]
        report["learner_data_audit"] = audit(backup, ROOT / "data" / "wenyan.db")
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        if report["status"] == "PASS" and (len(attempts) != 4 or not report["original_lock_unchanged"]
                or not report["original_policy_unchanged"] or report["new_provider_fetch_attempts"] != (3 if mode == "execute" else 0)):
            report["status"] = "FAILED_BUDGET_ACCOUNTING"
        save()
    print(json.dumps({name: report.get(name) for name in ("status", "error_type", "mode", "new_provider_fetch_attempts",
                     "provider_fetch_attempts_total", "original_lock_unchanged", "original_policy_unchanged", "owned_backend_stopped")}))
    print(str(report_file))


if __name__ == "__main__":
    main()
