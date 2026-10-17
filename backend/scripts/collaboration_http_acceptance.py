"""Real loopback HTTP acceptance with an owned mock backend supervisor.

Tokens are generated in memory, passed via child environment, and never printed
or persisted. The main backend remains running after successful acceptance.
The crash test uses its own port, collaboration database, and in-memory learner
database. This command refuses to start over an occupied main/QA port.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler

from backend.config import ROOT
from backend.scripts.editorial_data_audit import audit


OUTPUT = ROOT / "output" / "harness-http-acceptance-20261014"
TERMINAL = {"WAITING_REVIEW", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"}


def port_available(port: int) -> None:
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise RuntimeError(f"PORT_OCCUPIED:{port}")


class LocalBackend:
    def __init__(self, port: int, *, isolated: bool = False):
        self.port = port
        self.token = secrets.token_urlsafe(48)
        self.isolated = isolated
        self.process = None
        self.logs = []
        self.opener = build_opener(ProxyHandler({}))
        self.database = OUTPUT / f"crash-collaboration-{uuid.uuid4()}.db" if isolated else ROOT / "data" / "collaboration.db"

    def start(self, *, delay: float = 0.4, environment: dict[str, str] | None = None) -> None:
        port_available(self.port)
        env = os.environ.copy()
        env.update({
            "WENYAN_COLLABORATION_ENABLED": "1",
            "WENYAN_COLLABORATION_RUNTIME": "mock",
            "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "0",
            "WENYAN_COLLABORATION_TOKEN": self.token,
            "WENYAN_COLLABORATION_DATABASE_URL": f"sqlite:///{self.database}",
            "WENYAN_COLLABORATION_MOCK_STEP_DELAY_SECONDS": str(delay),
            "WENYAN_DATABASE_URL": "sqlite:///:memory:" if self.isolated else f"sqlite:///{ROOT / 'data' / 'wenyan.db'}",
        })
        env.pop("DEEPSEEK_API_KEY", None)
        if environment:
            env.update(environment)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        log_path = OUTPUT / f"backend-{self.port}-{uuid.uuid4()}.log"
        log = log_path.open("w", encoding="utf-8")
        self.logs.append(log_path)
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        self.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup,
        )
        log.close()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"BACKEND_START_FAILED:{self.port}:{log_path}")
            try:
                status, _ = self.request("GET", "/api/health", authenticated=False)
                if status == 200:
                    return
            except (URLError, TimeoutError, OSError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"BACKEND_START_TIMEOUT:{self.port}")

    def stop(self) -> None:
        if not self.process or self.process.poll() is not None:
            return
        helper = subprocess.run(
            [sys.executable, "-m", "backend.scripts.collaboration_local_control", str(self.process.pid)],
            cwd=ROOT, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if helper.returncode:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise RuntimeError("BACKEND_GRACEFUL_SIGNAL_FAILED:" + helper.stderr[-1000:]) from None
            if "Application shutdown complete" not in self.logs[-1].read_text(encoding="utf-8"):
                raise RuntimeError("BACKEND_SHUTDOWN_NOT_CONFIRMED")
        self.process.wait(timeout=20)

    def request(self, method: str, path: str, body=None, *, key=None, headers=None, authenticated=True):
        request_headers = {"Origin": "http://127.0.0.1:5173"}
        if authenticated:
            request_headers["Authorization"] = f"Bearer {self.token}"
        if key:
            request_headers["Idempotency-Key"] = key
        request_headers.update(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=data, headers=request_headers, method=method)
        try:
            response = self.opener.open(request, timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if "application/json" in response.headers.get("Content-Type", "") else raw

    def poll(self, run_id: str, expected: str | None = None, *, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code, result = self.request("GET", f"/api/v1/collaboration/runs/{run_id}")
            assert code == 200, (code, result)
            if result["status"] == expected or expected is None and result["status"] in TERMINAL:
                return result
            if expected is not None and result["status"] in TERMINAL:
                raise AssertionError(f"Unexpected terminal status: {result['status']}, expected {expected}")
            time.sleep(0.02)
        raise AssertionError(f"RUN_POLL_TIMEOUT:{run_id}:{expected}")


def task_body(label: str) -> dict:
    return {
        "project_id": "wenyan-harness-synthetic-acceptance",
        "title": f"合成 HTTP 验收：{label}",
        "objective": "仅检验本机 mock 协作接口和恢复行为。",
        "acceptance_criteria": ["结果为 synthetic CANDIDATE", "追问保持同任务绑定", "取消与恢复有持久记录"],
        "forbidden_actions": ["真实模型调用", "读取或写入学习记录"],
        "context_items": [{
            "layer": "project_baseline", "source_id": "synthetic/http-acceptance",
            "source_version": "20261014-v1", "classification": "synthetic",
            "content": "纯合成内容：设计一个只读任务并列出一个风险。",
        }],
    }


def run_main_acceptance(server: LocalBackend) -> dict:
    prefix = "/api/v1/collaboration"
    code, _ = server.request("POST", f"{prefix}/tasks", task_body("unauthorized"), authenticated=False)
    assert code == 401
    code, _ = server.request("POST", f"{prefix}/tasks", task_body("origin-denied"), headers={"Origin": "https://invalid.example"})
    assert code == 403
    code, task = server.request("POST", f"{prefix}/tasks", task_body("闭环"))
    assert code == 201
    task_id = task["task"]["id"]
    request = {"prompt": "列出只读协作风险", "manifest_version": 1}
    key = f"http-first-{uuid.uuid4()}"
    code, first = server.request("POST", f"{prefix}/tasks/{task_id}/runs", request, key=key)
    assert code == 201
    server.poll(first["id"], "RUNNING")
    follow_request = {"content": "请沿用本任务继续说明风险", "manifest_version": 1}
    follow_key = f"http-follow-{uuid.uuid4()}"
    code, follow = server.request("POST", f"{prefix}/tasks/{task_id}/messages", follow_request, key=follow_key)
    assert code == 202
    assert follow["run"]["status"] == "QUEUED"
    assert follow["queued_behind_active_run"] is True
    first_done = server.poll(first["id"])
    follow_done = server.poll(follow["run"]["id"])
    for result in (first_done, follow_done):
        assert result["status"] == "WAITING_REVIEW"
        assert result["runtime"] == "mock"
        assert result["artifacts"][0]["review_status"] == "CANDIDATE"
        assert result["artifacts"][0]["payload"]["metadata"]["synthetic"] is True
    assert follow_done["harness_session_id"] == first_done["harness_session_id"]
    assert follow_done["parent_run_id"] == first_done["id"]
    code, replay = server.request("POST", f"{prefix}/tasks/{task_id}/messages", follow_request, key=follow_key)
    assert code == 200 and replay["run"]["id"] == follow_done["id"]
    code, events = server.request("GET", f"{prefix}/runs/{first['id']}/events")
    assert code == 200 and "event: run.completed" in events
    ids = [int(line[4:]) for line in events.splitlines() if line.startswith("id: ")]
    code, resumed = server.request("GET", f"{prefix}/runs/{first['id']}/events", headers={"Last-Event-ID": str(ids[2])})
    assert code == 200
    assert all(int(line[4:]) > ids[2] for line in resumed.splitlines() if line.startswith("id: "))
    # Cancellation during execution and while queued are both observed over HTTP.
    code, active = server.request("POST", f"{prefix}/tasks/{task_id}/runs", {"prompt": "活动取消验收", "manifest_version": 1}, key=f"active-{uuid.uuid4()}")
    assert code == 201
    server.poll(active["id"], "RUNNING")
    code, queued = server.request("POST", f"{prefix}/tasks/{task_id}/messages", {"content": "排队取消验收", "manifest_version": 1}, key=f"queued-{uuid.uuid4()}")
    assert code == 202 and queued["run"]["status"] == "QUEUED"
    code, cancelled = server.request("POST", f"{prefix}/runs/{queued['run']['id']}/cancel")
    assert code == 200 and cancelled["status"] == "CANCELLED"
    code, _ = server.request("POST", f"{prefix}/runs/{active['id']}/cancel")
    assert code == 200
    active_done = server.poll(active["id"])
    assert active_done["status"] == "CANCELLED" and not active_done["artifacts"]
    _, before = server.request("GET", f"{prefix}/tasks/{task_id}/handoff")
    server.stop()
    assert "Application shutdown complete" in server.logs[-1].read_text(encoding="utf-8")
    server.start()
    _, after = server.request("GET", f"{prefix}/tasks/{task_id}/handoff")
    assert before == after
    code, replay = server.request("POST", f"{prefix}/tasks/{task_id}/runs", request, key=key)
    assert code == 200 and replay["id"] == first["id"]
    code, replay = server.request("POST", f"{prefix}/tasks/{task_id}/messages", follow_request, key=follow_key)
    assert code == 200 and replay["run"]["id"] == follow_done["id"]
    _, again = server.request("GET", f"{prefix}/tasks/{task_id}/handoff")
    assert len(again["runs"]) == 4 and len(again["messages"]) == 6
    return {
        "task_id": task_id, "first_run_id": first["id"], "followup_run_id": follow_done["id"],
        "first_result": first_done["status"], "followup_result": follow_done["status"],
        "active_cancel_run_id": active["id"], "queued_cancel_run_id": queued["run"]["id"],
        "active_cancel": active_done["status"], "queued_cancel": cancelled["status"],
        "handoff_persisted_after_normal_restart": True, "idempotent_recovery_no_new_runs": True,
        "sse_cursor_recovery": True, "authentication_denied": 401, "origin_denied": 403,
        "backend_pid": server.process.pid, "port": server.port,
    }


def run_crash_acceptance(server: LocalBackend) -> dict:
    assert server.isolated and server.port != 8000
    server.start(delay=10)
    prefix = "/api/v1/collaboration"
    code, task = server.request("POST", f"{prefix}/tasks", task_body("隔离异常退出"))
    assert code == 201
    task_id = task["task"]["id"]
    request = {"prompt": "模拟被中断的请求", "manifest_version": 1}
    key = str(uuid.uuid4())
    _, active = server.request("POST", f"{prefix}/tasks/{task_id}/runs", request, key=key)
    server.poll(active["id"], "RUNNING")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        _, state = server.request("GET", f"{prefix}/runs/{active['id']}")
        if state["harness_message_id"]:
            break
        time.sleep(0.02)
    assert state["harness_message_id"]
    _, queued = server.request("POST", f"{prefix}/tasks/{task_id}/messages", {"content": "重启后继续排队任务", "manifest_version": 1}, key=str(uuid.uuid4()))
    assert queued["run"]["status"] == "QUEUED"
    # Fault injection affects ONLY the Popen instance this test created.
    server.process.kill()
    server.process.wait(timeout=10)
    server.start(delay=0.1)
    unknown = server.poll(active["id"])
    completed = server.poll(queued["run"]["id"])
    assert unknown["status"] == "OUTCOME_UNKNOWN" and not unknown["artifacts"]
    assert unknown["outcome_code"] == "BRIDGE_RESTARTED_AFTER_DISPATCH"
    assert completed["status"] == "WAITING_REVIEW"
    code, replay = server.request("POST", f"{prefix}/tasks/{task_id}/runs", request, key=key)
    assert code == 200 and replay["id"] == active["id"] and replay["status"] == "OUTCOME_UNKNOWN"
    _, handoff = server.request("GET", f"{prefix}/tasks/{task_id}/handoff")
    assert len(handoff["runs"]) == 2
    assert sum(item["event_type"] == "run.started" and item["run_id"] == active["id"] for item in handoff["audit_events"]) == 1
    server.stop()
    return {"isolated_port": server.port, "task_id": task_id, "unknown_run_id": active["id"],
            "unknown_status": unknown["status"], "queued_recovered_status": completed["status"],
            "automatic_retry": False, "isolated_learner_database": ":memory:", "qa_service_stopped": True}


def main():
    global OUTPUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", required=True, type=Path)
    parser.add_argument("--qa-port", type=int, default=8001)
    parser.add_argument("--report-dir", type=Path)
    args = parser.parse_args()
    if args.report_dir is not None:
        report_dir = args.report_dir.resolve()
        if not report_dir.is_relative_to((ROOT / "output").resolve()):
            raise RuntimeError("REPORT_DIRECTORY_OUTSIDE_PROJECT_OUTPUT")
        OUTPUT = report_dir
    port_available(8000)
    port_available(args.qa_port)
    main_server = LocalBackend(8000)
    qa_server = LocalBackend(args.qa_port, isolated=True)
    try:
        main_server.start()
        main_result = run_main_acceptance(main_server)
        crash_result = run_crash_acceptance(qa_server)
        comparison = audit(args.backup, ROOT / "data" / "wenyan.db")
        assert comparison["integrity"] == "ok" and comparison["preexisting_rows_unchanged"]
        assert all(item["before"] == item["after"] for item in comparison["tables"])
        report = {
            "status": "PASS", "runtime": "mock", "real_calls_enabled": False,
            "main_http": main_result, "isolated_crash_recovery": crash_result,
            "learner_database": comparison,
            "service_token_storage": "supervisor/child process memory only",
        }
        (OUTPUT / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)
        print("MOCK_BACKEND_READY; SUPERVISOR_WAITING", flush=True)
        main_server.process.wait()
    except Exception:
        if qa_server.process and qa_server.process.poll() is None:
            qa_server.stop()
        # Keep an already-started main backend available even if QA fails.
        raise


if __name__ == "__main__":
    main()
