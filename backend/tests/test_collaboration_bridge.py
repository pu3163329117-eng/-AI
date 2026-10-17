from __future__ import annotations

import hashlib
import json
from pathlib import Path
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import inspect, select

from backend.collaboration.config import CollaborationSettings
from backend.collaboration.contracts import CreateManifestRequest, CreateRunRequest, CreateTaskRequest, FollowUpRequest
from backend.collaboration.controller import controller
from backend.collaboration.database import create_collaboration_database, init_collaboration_database
from backend.collaboration.models import CollaborationRun
from backend.collaboration.routes import router
from backend.collaboration.runtime import MockHarnessAdapter, PROFILE_PATCH, RuntimeFailure
from backend.collaboration.service import BridgeError, CollaborationService, CollaborationWorker


def request_task(*, project_id: str = "wenyan", suffix: str = "") -> CreateTaskRequest:
    return CreateTaskRequest(
        project_id=project_id,
        title=f"只读审查{suffix}",
        objective="检查合成接口契约，不访问学生记录。",
        acceptance_criteria=["返回候选结果", "标明未做真实调用"],
        forbidden_actions=["写学习库", "执行 Shell", "发布"],
        context_items=[{
            "layer": "project_baseline",
            "source_id": f"docs/baseline{suffix}",
            "source_version": "sha256:test-v1",
            "classification": "synthetic",
            "content": "这是不含个人数据的合成项目基线。",
        }],
    )


@pytest.fixture
def bridge():
    db_path = Path("data") / f".test-collaboration-{uuid.uuid4()}.db"
    engine, factory = create_collaboration_database(f"sqlite:///{db_path.resolve()}")
    init_collaboration_database(engine)
    service = CollaborationService(factory, MockHarnessAdapter(step_delay=0.005))
    yield service, engine, factory
    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(f"{db_path}{suffix}")
        if candidate.exists():
            candidate.unlink()


def wait_terminal(service: CollaborationService, run_id: str, timeout: float = 3) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = service.get_run(run_id)
        if result["status"] in {"WAITING_REVIEW", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"}:
            return result
        time.sleep(0.01)
    raise AssertionError(f"run {run_id} did not finish")


def test_mock_end_to_end_followup_idempotency_and_event_resume(bridge):
    service, _engine, _factory = bridge
    worker = CollaborationWorker(service)
    worker.start()
    try:
        created = service.create_task(request_task())
        task_id = created["task"]["id"]
        manifest = created["context_manifest"]
        first_request = CreateRunRequest(prompt="给出只读审查摘要", manifest_version=1)
        first, was_created = service.create_run(task_id, first_request, "run-1")
        assert was_created is True
        duplicate, was_created = service.create_run(task_id, first_request, "run-1")
        assert was_created is False
        assert duplicate["id"] == first["id"]

        first_done = wait_terminal(service, first["id"])
        assert first_done["status"] == "WAITING_REVIEW"
        assert first_done["artifacts"][0]["review_status"] == "CANDIDATE"
        assert first_done["artifacts"][0]["payload"]["metadata"]["synthetic"] is True
        assert first_done["harness_message_id"].startswith("mock-message-")

        followup, followup_created = service.append_message(
            task_id, FollowUpRequest(content="再说明一个风险", manifest_version=1), "followup-1",
        )
        assert followup_created is True
        followup_done = wait_terminal(service, followup["run"]["id"])
        assert followup_done["parent_run_id"] == first["id"]
        assert followup_done["harness_session_id"] == first_done["harness_session_id"]
        replay, replay_created = service.append_message(
            task_id, FollowUpRequest(content="再说明一个风险", manifest_version=1), "followup-1",
        )
        assert replay_created is False
        assert replay["run"]["id"] == followup_done["id"]

        events = service.get_events(first["id"])
        assert [event["id"] for event in events] == list(range(1, len(events) + 1))
        resumed = service.get_events(first["id"], events[2]["id"])
        assert resumed[0]["id"] == events[3]["id"]
        assert any(event["event"] == "runtime.message_enqueued" for event in events)
        assert events[-1]["event"] == "run.completed"

        handoff = service.handoff(task_id)
        assert len(handoff["runs"]) == 2
        assert any(event["event_type"] == "task.created" for event in handoff["audit_events"])
        assert any(event["event_type"] == "run.completed" for event in handoff["audit_events"])
        assert handoff["verification"]["model_outputs_are_candidates"] is True
        assert handoff["context_manifests"][0]["content_sha256"] == manifest["content_sha256"]
    finally:
        worker.stop()


def test_idempotency_conflict_and_manifest_version_guard(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    service.create_run(task_id, CreateRunRequest(prompt="A", manifest_version=1), "same-key")
    with pytest.raises(BridgeError) as conflict:
        service.create_run(task_id, CreateRunRequest(prompt="B", manifest_version=1), "same-key")
    assert conflict.value.code == "IDEMPOTENCY_KEY_REUSED"
    with pytest.raises(BridgeError) as missing:
        service.create_run(task_id, CreateRunRequest(prompt="A", manifest_version=2), "new-key")
    assert missing.value.code == "CONTEXT_MANIFEST_VERSION_NOT_FOUND"


def test_concurrent_followup_recovery_creates_only_one_run(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="first", manifest_version=1), "first")
    request = FollowUpRequest(content="same followup", manifest_version=1)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: service.append_message(task_id, request, "same"), range(8)))
    assert sum(created for _payload, created in results) == 1
    assert len({payload["run"]["id"] for payload, _ in results}) == 1
    assert all(payload["run"]["parent_run_id"] == first["id"] for payload, _ in results)
    assert len(service.handoff(task_id)["runs"]) == 2


def test_cancel_between_claim_and_adapter_start_is_not_lost(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    run, _ = service.create_run(task_id, CreateRunRequest(prompt="cancel before adapter", manifest_version=1), "gap")
    assert service.claim_next_run() == run["id"]
    service.cancel(run["id"])
    service.execute_run(run["id"])
    result = service.get_run(run["id"])
    assert result["status"] == "CANCELLED"
    assert result["artifacts"] == []


def test_manifest_cas_idempotency_and_old_results_need_revalidation(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="v1", manifest_version=1), "v1-run")
    assert service.claim_next_run() == first["id"]
    service.execute_run(first["id"])
    update = CreateManifestRequest(
        expected_current_version=1,
        context_items=[{
            "layer": "project_baseline", "source_id": "docs/baseline-v2",
            "source_version": "sha256:test-v2", "classification": "synthetic",
            "content": "第二版合成基线。",
        }],
    )
    manifest, created = service.create_manifest(task_id, update, "manifest-v2")
    assert created is True and manifest["version"] == 2
    duplicate, created = service.create_manifest(task_id, update, "manifest-v2")
    assert created is False and duplicate["id"] == manifest["id"]
    assert service.get_run(first["id"])["needs_revalidation"] is True
    with pytest.raises(BridgeError) as stale:
        service.create_run(task_id, CreateRunRequest(prompt="stale", manifest_version=1), "stale")
    assert stale.value.code == "CONTEXT_MANIFEST_STALE"


def test_context_source_id_cannot_request_env_or_parent_path():
    for source_id in ("../.env", "C:\\Users\\admin\\.env", "/etc/passwd"):
        with pytest.raises(ValueError):
            CreateTaskRequest(
                project_id="safe", title="safe", objective="safe",
                acceptance_criteria=["safe"],
                context_items=[{
                    "layer": "evidence", "source_id": source_id,
                    "source_version": "v1", "classification": "synthetic", "content": "safe",
                }],
            )


def test_cross_task_sessions_and_context_do_not_mix(bridge):
    service, *_ = bridge
    one = service.create_task(request_task(project_id="one", suffix="-one"))
    two = service.create_task(request_task(project_id="two", suffix="-two"))
    run_one, _ = service.create_run(one["task"]["id"], CreateRunRequest(prompt="one", manifest_version=1), "one")
    run_two, _ = service.create_run(two["task"]["id"], CreateRunRequest(prompt="two", manifest_version=1), "two")
    assert run_one["harness_session_id"] != run_two["harness_session_id"]
    assert service.handoff(one["task"]["id"])["context_manifests"][0]["items"][0]["source_id"].endswith("-one")
    assert service.handoff(two["task"]["id"])["context_manifests"][0]["items"][0]["source_id"].endswith("-two")


def test_cancel_queued_and_running_only_targets_owned_run(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    queued, _ = service.create_run(task_id, CreateRunRequest(prompt="queued", manifest_version=1), "queued")
    cancelled = service.cancel(queued["id"])
    assert cancelled["status"] == "CANCELLED"
    assert cancelled["outcome_code"] == "CANCELLED_BEFORE_START"

    slow = CollaborationService(service.session_factory, MockHarnessAdapter(step_delay=0.3))
    running, _ = slow.create_run(task_id, CreateRunRequest(prompt="running", manifest_version=1), "running")
    claimed = slow.claim_next_run()
    assert claimed == running["id"]
    thread = threading.Thread(target=slow.execute_run, args=(running["id"],))
    thread.start()
    deadline = time.monotonic() + 2
    while not slow.get_run(running["id"])["started_at"] and time.monotonic() < deadline:
        time.sleep(0.01)
    slow.cancel(running["id"])
    thread.join(timeout=3)
    assert slow.get_run(running["id"])["status"] == "CANCELLED"


def test_restart_marks_only_running_outcome_unknown_without_requeue(bridge):
    service, *_ = bridge
    task_id = service.create_task(request_task())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="first", manifest_version=1), "first")
    second, _ = service.create_run(task_id, CreateRunRequest(prompt="second", manifest_version=1), "second")
    assert service.claim_next_run() == first["id"]
    recovered = CollaborationService(service.session_factory, MockHarnessAdapter())
    assert recovered.recover_interrupted() == 1
    assert recovered.get_run(first["id"])["status"] == "OUTCOME_UNKNOWN"
    assert recovered.get_run(second["id"])["status"] == "QUEUED"
    assert recovered.claim_next_run() == second["id"]


def test_enqueue_receipt_followed_by_disconnect_is_unknown_and_not_retried(bridge):
    service, _engine, factory = bridge

    class LostResponseAdapter:
        name = "lost-response-simulator"

        def run(self, envelope, emit, cancel_event):
            emit("runtime.started", {"runtime": self.name, "session_id": envelope.session_id})
            emit("runtime.message_enqueued", {"message_id": "enqueued-only"})
            raise RuntimeFailure("SIMULATED_DISCONNECT_AFTER_ENQUEUE", outcome_unknown=True)

        def cancel(self, run_id):
            return None

    lost = CollaborationService(factory, LostResponseAdapter())
    task_id = lost.create_task(request_task())["task"]["id"]
    run, _ = lost.create_run(task_id, CreateRunRequest(prompt="do not retry", manifest_version=1), "unknown-run")
    assert lost.claim_next_run() == run["id"]
    lost.execute_run(run["id"])
    result = lost.get_run(run["id"])
    assert result["status"] == "OUTCOME_UNKNOWN"
    assert result["harness_message_id"] == "enqueued-only"
    assert result["artifacts"] == []
    assert lost.claim_next_run() is None
    assert lost.get_events(run["id"])[-1]["data"]["automatic_retry"] is False


def test_collaboration_database_is_separate_and_has_only_bridge_tables(bridge):
    _service, collab_engine, _factory = bridge
    tables = set(inspect(collab_engine).get_table_names())
    assert tables == {
        "collaboration_tasks", "collaboration_context_manifests", "collaboration_messages",
        "collaboration_runs", "collaboration_artifacts", "collaboration_audit_events",
    }
    assert not any(name in tables for name in {"learner_profiles", "training_sessions", "lessons"})


def test_profile_disables_shell_and_real_runtime_requires_explicit_double_switch():
    assert "id: persistent-bash\n  disabled: true" in PROFILE_PATCH
    assert "id: persistent-pwsh\n  disabled: true" in PROFILE_PATCH
    with pytest.raises(ValueError, match="REAL_HARNESS_CALLS_NOT_AUTHORIZED"):
        CollaborationSettings(
            enabled=True, token="x" * 24, runtime="dsh-stdio", real_calls_enabled=False,
        ).validate()


def test_route_auth_origin_and_sse_resume(bridge):
    service, *_ = bridge
    old_settings, old_service = controller.settings, controller.service
    controller.settings = CollaborationSettings(enabled=True, token="t" * 32)
    controller.service = service
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, base_url="http://127.0.0.1")
    headers = {"Authorization": f"Bearer {'t' * 32}", "Origin": "http://127.0.0.1:5173"}
    try:
        assert client.post("/api/v1/collaboration/tasks", json=request_task().model_dump(mode="json")).status_code == 401
        denied = client.post(
            "/api/v1/collaboration/tasks", json=request_task().model_dump(mode="json"),
            headers={**headers, "Origin": "https://evil.example"},
        )
        assert denied.status_code == 403
        created = client.post("/api/v1/collaboration/tasks", json=request_task().model_dump(mode="json"), headers=headers)
        assert created.status_code == 201
        task_id = created.json()["task"]["id"]
        run = client.post(
            f"/api/v1/collaboration/tasks/{task_id}/runs",
            json={"prompt": "SSE", "manifest_version": 1},
            headers={**headers, "Idempotency-Key": "sse-run"},
        )
        assert run.status_code == 201
        run_id = run.json()["id"]
        assert service.claim_next_run() == run_id
        service.execute_run(run_id)
        all_events = client.get(f"/api/v1/collaboration/runs/{run_id}/events", headers=headers)
        assert all_events.status_code == 200
        first_id = int(all_events.text.splitlines()[0].removeprefix("id: "))
        resumed = client.get(
            f"/api/v1/collaboration/runs/{run_id}/events",
            headers={**headers, "Last-Event-ID": str(first_id)},
        )
        assert f"id: {first_id}\n" not in resumed.text
    finally:
        controller.settings, controller.service = old_settings, old_service


def test_main_lifespan_runs_file_backed_mock_bridge(monkeypatch):
    from backend.main import app

    token = "lifespan-token-0123456789abcdef"
    db_path = (Path("data") / f".test-collaboration-lifespan-{uuid.uuid4()}.db").resolve()
    monkeypatch.setenv("WENYAN_COLLABORATION_ENABLED", "1")
    monkeypatch.setenv("WENYAN_COLLABORATION_RUNTIME", "mock")
    monkeypatch.setenv("WENYAN_COLLABORATION_REAL_CALLS_ENABLED", "0")
    monkeypatch.setenv("WENYAN_COLLABORATION_TOKEN", token)
    monkeypatch.setenv("WENYAN_COLLABORATION_DATABASE_URL", f"sqlite:///{db_path}")
    headers = {"Authorization": f"Bearer {token}", "Origin": "http://127.0.0.1:5173"}
    try:
        with TestClient(app, base_url="http://127.0.0.1") as client:
            created = client.post("/api/v1/collaboration/tasks", json=request_task().model_dump(mode="json"), headers=headers)
            assert created.status_code == 201
            task_id = created.json()["task"]["id"]
            queued = client.post(
                f"/api/v1/collaboration/tasks/{task_id}/runs",
                json={"prompt": "lifespan mock", "manifest_version": 1},
                headers={**headers, "Idempotency-Key": "lifespan-run"},
            )
            assert queued.status_code == 201
            run_id = queued.json()["id"]
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                result = client.get(f"/api/v1/collaboration/runs/{run_id}", headers=headers)
                if result.json()["status"] == "WAITING_REVIEW":
                    break
                time.sleep(0.01)
            assert result.json()["status"] == "WAITING_REVIEW"
            assert result.json()["artifacts"][0]["payload"]["metadata"]["synthetic"] is True
        assert db_path.exists()
    finally:
        controller.shutdown()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(f"{db_path}{suffix}")
            if candidate.exists():
                candidate.unlink()
