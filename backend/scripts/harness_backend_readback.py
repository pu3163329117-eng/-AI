"""Read the existing isolated integration database without model credentials.

No new task or run is created. The one POST reuses the original idempotency key
and payload, asserting that it returns the same terminal run without dispatch.
"""
import json
import sqlite3
import argparse

from backend.config import ROOT
from backend.collaboration.synthetic_budget import PROMPTS
from backend.scripts import collaboration_http_acceptance as local_http


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--after-continuation", action="store_true")
    args = parser.parse_args()
    directory = ROOT / "output" / "harness-backend-20261015" / "real"
    database = directory / "collaboration.db"
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        run_id, task_id, status, outcome = db.execute(
            "SELECT id,task_id,status,outcome_code FROM collaboration_runs WHERE idempotency_key='closure:first'").fetchone()
        assert status == "OUTCOME_UNKNOWN" and outcome == "DSH_RUN_TIMEOUT"
        assert db.execute("SELECT count(*) FROM collaboration_runs WHERE status IN ('RUNNING','QUEUED')").fetchone()[0] == 0
        terminals = db.execute("SELECT id,status,outcome_code FROM collaboration_runs ORDER BY created_at").fetchall()
    before = {path.name: path.read_bytes() for path in (directory / "attempts").glob("*.json")}
    local_http.OUTPUT = directory
    server = local_http.LocalBackend(8001, isolated=True)
    server.database = database
    environment = {"WENYAN_COLLABORATION_RUNTIME": "dsh-stdio", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "1",
                   "WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(directory / "budget-policy.json"),
                   "WENYAN_COLLABORATION_MAX_TOKENS": "128", "WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS": "60"}
    # LocalBackend explicitly removes DEEPSEEK_API_KEY. No credential loan,
    # personal-file read, generated run, or worker dispatch in this command.
    result = {"status": "PREPARING", "new_provider_requests": 0, "credential_loaded": False}
    try:
        server.start(environment=environment)
        result["owned_backend_pid"] = server.process.pid
        code, run = server.request("GET", f"/api/v1/collaboration/runs/{run_id}")
        assert code == 200 and run["status"] == "OUTCOME_UNKNOWN" and run["artifacts"] == []
        body = {"prompt": PROMPTS["first"], "manifest_version": 1, "max_output_tokens": 128, "timeout_seconds": 60}
        code, replay = server.request("POST", f"/api/v1/collaboration/tasks/{task_id}/runs", body, key="closure:first")
        assert code == 200 and replay["id"] == run_id and replay["status"] == "OUTCOME_UNKNOWN"
        code, events = server.request("GET", f"/api/v1/collaboration/runs/{run_id}/events")
        assert code == 200 and "event: run.outcome_unknown" in events
        ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
        code, tail = server.request("GET", f"/api/v1/collaboration/runs/{run_id}/events", headers={"Last-Event-ID": str(ids[1])})
        assert code == 200 and all(int(line[4:]) > ids[1] for line in tail.splitlines() if line.startswith("id: "))
        code, handoff = server.request("GET", f"/api/v1/collaboration/tasks/{task_id}/handoff")
        assert code == 200 and len(handoff["runs"]) == 1 and handoff["verification"]["automatic_retry_of_unknown_outcomes"] is False
        after = {path.name: path.read_bytes() for path in (directory / "attempts").glob("*.json")}
        assert after == before
        result.update(status="PASS", run=run, idempotent_replay_same_terminal_run=True,
                      sse_cursor_read="PASS", handoff_read="PASS", original_attempt_locks_unchanged=True)
        if args.after_continuation:
            result["all_terminal_reads"] = []
            for terminal_id, terminal_status, terminal_outcome in terminals:
                code, current = server.request("GET", f"/api/v1/collaboration/runs/{terminal_id}")
                assert code == 200 and current["status"] == terminal_status and current["outcome_code"] == terminal_outcome
                result["all_terminal_reads"].append({"run_id": terminal_id, "status": terminal_status, "outcome_code": terminal_outcome})
    finally:
        server.stop()
        result["owned_backend_stopped"] = server.process.poll() is not None
        report_name = "readback-after-continuation.json" if args.after_continuation else "readback.json"
        (directory / report_name).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("status", "new_provider_requests", "credential_loaded", "owned_backend_stopped")}))


if __name__ == "__main__":
    main()
