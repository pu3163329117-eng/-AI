"""Actual FastAPI/HTTP + actual pinned Harness, with a bounded provider seam.

Default mode replaces provider fetch with synthetic SSE (zero network calls).
--execute-approved-four-calls is exclusively for the separately approved four
synthetic attempts and credential loan. It refuses an existing real directory.
3080, the existing 8000 service and existing learning/collaboration data are not
modified. Only this launcher's isolated 8001 service is stopped or fault-killed.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
import uuid

from backend.config import ROOT
from backend.collaboration.synthetic_budget import CANDIDATE, PROMPTS, QUEUED_CANCEL_PROMPT, make_policy, task_request
from backend.scripts import collaboration_http_acceptance as local_http
from backend.scripts.editorial_data_audit import audit
from backend.scripts.harness_synthetic_single_call import resolve_credential


PREFIX = "/api/v1/collaboration"


def alive(pid):
    if os.name != "nt":
        raise RuntimeError("WINDOWS_ACCEPTANCE_ONLY")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x100000, False, pid)
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(handle, 0) == 258
    finally:
        kernel.CloseHandle(handle)


def wait_child_exit(pid, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not alive(pid):
            return
        time.sleep(0.05)
    raise RuntimeError("OWNED_HARNESS_CHILD_NOT_REAPED")


def observation(run_id):
    return ROOT / "data" / "dsh-collaboration-controls" / run_id / "transport.json"


def wait_held(server, run_id):
    deadline = time.monotonic() + 62
    while time.monotonic() < deadline:
        file = observation(run_id)
        if file.exists():
            result = json.loads(file.read_text(encoding="utf-8"))
            if result.get("held_after_headers") and result.get("http_status") == 200:
                server.poll(run_id, "RUNNING")
                return result
        code, current = server.request("GET", f"{PREFIX}/runs/{run_id}")
        assert code == 200
        if current["status"] in local_http.TERMINAL:
            raise RuntimeError("RUN_ENDED_BEFORE_INJECTION:" + str(current.get("outcome_code")))
        time.sleep(0.04)
    raise RuntimeError("PROVIDER_HEADERS_NOT_OBSERVED")


def create_task(server):
    code, task = server.request("POST", f"{PREFIX}/tasks", task_request())
    assert code == 201
    return task["task"]["id"]


def create_run(server, task_id, scenario):
    body = {"prompt": PROMPTS[scenario], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, run = server.request("POST", f"{PREFIX}/tasks/{task_id}/runs", body, key=f"closure:{scenario}")
    assert code == 201
    return run, body


def completed(server, run_id, synthetic):
    done = server.poll(run_id, timeout=68)
    assert done["status"] == "WAITING_REVIEW", done.get("outcome_code")
    artifact = done["artifacts"][0]
    assert artifact["review_status"] == "CANDIDATE"
    assert json.loads(artifact["payload"]["text"]) == CANDIDATE
    assert artifact["payload"]["metadata"]["synthetic"] is synthetic
    assert artifact["payload"]["metadata"]["runtime_shutdown_graceful"] is True
    return done


def run_suite(server, environment, report, save):
    synthetic = report["mode"] == "offline"
    server.start(environment=environment)
    report["owned_backend_pids"] = [server.process.pid]
    main_task = create_task(server)
    first, first_body = create_run(server, main_task, "first")
    first_done = completed(server, first["id"], synthetic)
    report["first"] = first_done
    save()
    code, duplicate = server.request("POST", f"{PREFIX}/tasks/{main_task}/runs", first_body, key="closure:first")
    assert code == 200 and duplicate["id"] == first["id"]
    # Read-only snapshots and cursor continuation never create a new run.
    code, events = server.request("GET", f"{PREFIX}/runs/{first['id']}/events")
    assert code == 200 and "event: runtime.turn_completed" in events and "event: run.completed" in events
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    code, tail = server.request("GET", f"{PREFIX}/runs/{first['id']}/events", headers={"Last-Event-ID": str(ids[2])})
    assert code == 200 and all(int(line[4:]) > ids[2] for line in tail.splitlines() if line.startswith("id: "))
    report["result_and_sse_reads"] = "PASS"
    server.stop()
    server.start(environment=environment)
    report["owned_backend_pids"].append(server.process.pid)
    restored = server.poll(first["id"], "WAITING_REVIEW")
    assert restored["artifacts"][0]["id"] == first_done["artifacts"][0]["id"]
    report["normal_restart_read"] = "PASS"
    follow_body = {"content": PROMPTS["followup"], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, follow = server.request("POST", f"{PREFIX}/tasks/{main_task}/messages", follow_body, key="closure:followup")
    assert code == 202
    follow_done = completed(server, follow["run"]["id"], synthetic)
    assert follow_done["parent_run_id"] == first["id"]
    metadata = follow_done["artifacts"][0]["payload"]["metadata"]
    assert metadata["history_messages"] == 2 and metadata["history_mode"] == "bridge_replay"
    assert first_done["harness_session_id"] != follow_done["harness_session_id"]
    code, follow_replay = server.request("POST", f"{PREFIX}/tasks/{main_task}/messages", follow_body, key="closure:followup")
    assert code == 200 and follow_replay["run"]["id"] == follow_done["id"]
    report["followup_after_restart"] = follow_done
    save()

    cancel_task = create_task(server)
    active, _ = create_run(server, cancel_task, "cancel")
    cancel_evidence = wait_held(server, active["id"])
    queued_body = {"content": QUEUED_CANCEL_PROMPT, "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
    code, queued = server.request("POST", f"{PREFIX}/tasks/{cancel_task}/messages", queued_body, key="closure:queued-cancel")
    assert code == 202 and queued["run"]["status"] == "QUEUED"
    code, queued_done = server.request("POST", f"{PREFIX}/runs/{queued['run']['id']}/cancel")
    assert code == 200 and queued_done["status"] == "CANCELLED" and queued_done["outcome_code"] == "CANCELLED_BEFORE_START"
    code, _ = server.request("POST", f"{PREFIX}/runs/{active['id']}/cancel")
    assert code == 200
    cancelled = server.poll(active["id"], "CANCELLED")
    assert cancelled["artifacts"] == []
    wait_child_exit(cancel_evidence["child_pid"])
    report["running_cancel"] = {"run": cancelled, "provider_headers_before_cancel": cancel_evidence, "owned_child_exited": True}
    report["queued_cancel"] = queued_done
    save()

    interrupted_task = create_task(server)
    interrupted, interrupted_body = create_run(server, interrupted_task, "interrupted")
    crash_evidence = wait_held(server, interrupted["id"])
    assert crash_evidence["owner_pid"] == server.process.pid
    report["crash_checkpoint"] = {"run_id": interrupted["id"], "transport": crash_evidence}
    save()
    server.process.kill()  # Exact Popen created by this launcher, never 3080/8000.
    server.process.wait(timeout=10)
    wait_child_exit(crash_evidence["child_pid"])
    server.start(environment=environment)
    report["owned_backend_pids"].append(server.process.pid)
    recovered = server.poll(interrupted["id"], "OUTCOME_UNKNOWN")
    assert recovered["outcome_code"] == "BRIDGE_RESTARTED_AFTER_DISPATCH" and recovered["artifacts"] == []
    code, replay = server.request("POST", f"{PREFIX}/tasks/{interrupted_task}/runs", interrupted_body, key="closure:interrupted")
    assert code == 200 and replay["id"] == interrupted["id"] and replay["status"] == "OUTCOME_UNKNOWN"
    report["interrupted_recovery"] = {"run": recovered, "automatic_retry": False, "owned_child_exited": True}
    assert server.poll(first["id"], "WAITING_REVIEW")["artifacts"][0]["id"] == first_done["artifacts"][0]["id"]
    assert server.poll(active["id"], "CANCELLED")["artifacts"] == []
    # Deliberately exhaust a scenario: rejects before child creation or fetch.
    denied_task = create_task(server)
    denied, _ = create_run(server, denied_task, "first")
    rejected = server.poll(denied["id"], "FAILED")
    assert rejected["outcome_code"] == "DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY"
    report["budget_denial"] = rejected
    report["scoped_history_native_restore_claimed"] = False
    save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-approved-four-calls", action="store_true")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if args.port in {3080, 8000, 5173}:
        raise RuntimeError("EXISTING_SERVICE_PORT_DENIED")
    mode = "execute" if args.execute_approved_four_calls else "offline"
    base = ROOT / "output" / "harness-backend-20261015"
    directory = base / ("real" if mode == "execute" else f"offline-{uuid.uuid4()}")
    local_http.port_available(args.port)
    directory.mkdir(parents=True, exist_ok=False)
    policy_file = directory / "budget-policy.json"
    policy_file.write_text(json.dumps(make_policy(mode), ensure_ascii=False, indent=2), encoding="utf-8")
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(args.port, isolated=True)
    server.database = directory / "collaboration.db"
    report = {"status": "PREPARING", "mode": mode, "model_calls_budget": 4, "output_token_budget": 512,
              "automatic_retries": 0, "port": args.port, "policy_file": str(policy_file)}
    backup = ROOT / "output" / "backups" / "wenyan-before-harness-backend-20261015.db"
    if not backup.exists():
        if mode == "execute":
            raise RuntimeError("FRESH_LEARNER_BACKUP_REQUIRED")
        backup = ROOT / "output" / "backups" / "wenyan-before-stdio-offline-20261014.db"
    report["learner_backup"] = str(backup)
    report_file = directory / "acceptance.json"
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if mode == "execute":
        key, _ = resolve_credential(SimpleNamespace(allow_personal_credential=True,
                   credential_file=Path(r"C:\Users\admin\.dsh\.credentials.yaml")))
    else:
        key = "synthetic-offline-not-a-real-key"
    environment = {"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                   "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(policy_file),
                   "WENYAN_COLLABORATION_MAX_TOKENS": "128", "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "60",
                   "DEEPSEEK_API_KEY": key}
    started = time.monotonic()
    try:
        save()
        run_suite(server, environment, report, save)
        report["status"] = "PASS"
    except Exception as error:
        # No raw request, credential parser, or provider exception is printed.
        report.update(status="FAILED_NO_RETRY", error_type=type(error).__name__)
    finally:
        server.stop()
        environment.pop("DEEPSEEK_API_KEY", None)
        key = ""
        attempts = [json.loads(path.read_text(encoding="utf-8")) for path in (directory / "attempts").glob("*.json")]
        report["attempts"] = attempts
        report["provider_fetch_attempts"] = sum(item["provider_fetch_attempts"] for item in attempts)
        report["fake_transport_calls"] = sum(item["fake_transport_calls"] for item in attempts)
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["learner_data_audit"] = audit(backup, ROOT / "data" / "wenyan.db")
        report["owned_backend_stopped"] = server.process is None or server.process.poll() is not None
        # Preserve terminal evidence even if an assertion stopped the suite
        # before the successful-stage checkpoint was written.
        import sqlite3
        with sqlite3.connect(server.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
            report["terminal_runs"] = [dict(zip(("run_id", "status", "outcome_code"), row)) for row in db.execute(
                "SELECT id,status,outcome_code FROM collaboration_runs ORDER BY created_at")]
        if report["status"] == "PASS":
            if len(attempts) != 4 or report["provider_fetch_attempts"] != (4 if mode == "execute" else 0):
                report.update(status="FAILED_BUDGET_ACCOUNTING", error_type="BudgetAccountingMismatch")
        save()
    print(json.dumps({key: report.get(key) for key in ("status", "error_type", "mode", "provider_fetch_attempts", "fake_transport_calls", "elapsed_seconds", "owned_backend_stopped")}, ensure_ascii=False))
    print(str(report_file))


if __name__ == "__main__":
    main()
