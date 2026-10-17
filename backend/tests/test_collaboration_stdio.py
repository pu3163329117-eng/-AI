from __future__ import annotations

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

import pytest

from backend.config import ROOT
from backend.collaboration.config import CollaborationSettings
from backend.collaboration.contracts import CreateManifestRequest, CreateRunRequest, CreateTaskRequest, FollowUpRequest
from backend.collaboration.database import create_collaboration_database, init_collaboration_database
from backend.collaboration.runtime import DISABLED_PROFILE_ENTRIES, DshStdioAdapter, RunCancelled, RunEnvelope, RuntimeFailure
from backend.collaboration.service import CollaborationService
from backend.scripts.harness_stdio_preview import synthetic_packet, validate_existing_packet


FIXTURE_PEER = Path(__file__).resolve().parent / "fixtures" / "dsh_stdio_peer.py"


def frozen_packet():
    prompt = DshStdioAdapter._build_prompt(synthetic_packet())
    encoded = prompt.encode("utf-8")
    return {"prompt": prompt, "prompt_bytes": len(encoded),
            "prompt_sha256": hashlib.sha256(encoded).hexdigest(),
            "runtime_version": "0.2.0-rc.2", "wire_server_version": "0.0.1",
            "provider": "deepseek-official", "model": "deepseek-flash",
            "budget": {"max_prompt_dispatches": 1, "max_output_tokens": 128,
                       "max_input_bytes": 8192, "max_seconds": 60, "automatic_retries": 0}}


def test_frozen_synthetic_packet_is_verified_without_launch_or_credential(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("packet verification must never start a process")
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    packet = frozen_packet()
    assert validate_existing_packet(packet) == (1904, packet["prompt_sha256"])


@pytest.mark.parametrize("field,value", [
    ("max_prompt_dispatches", 2), ("max_output_tokens", 129),
    ("max_input_bytes", 8193), ("max_seconds", 61), ("automatic_retries", 1),
])
def test_frozen_packet_rejects_expanded_budget(field, value):
    packet = frozen_packet()
    packet["budget"][field] = value
    with pytest.raises(ValueError, match="SYNTHETIC_PACKET_CHANGED"):
        validate_existing_packet(packet)


def test_frozen_packet_rejects_expanded_content_even_with_matching_digest():
    packet = frozen_packet()
    packet["prompt"] += "UNAPPROVED_ADDITIONAL_CONTENT"
    encoded = packet["prompt"].encode("utf-8")
    packet.update(prompt_bytes=len(encoded), prompt_sha256=hashlib.sha256(encoded).hexdigest())
    with pytest.raises(ValueError, match="SYNTHETIC_PACKET_CHANGED"):
        validate_existing_packet(packet)


class FixtureAdapter(DshStdioAdapter):
    """Only launch is replaced; production framing and correlation run unchanged."""
    synthetic = True
    shutdown_grace_seconds = 0.3

    def __init__(self, scenario="normal", **settings):
        super().__init__(replace(CollaborationSettings(), **settings))
        self.scenario = scenario
        self.children = []

    def _launch_process(self, envelope):
        env = {name: os.environ[name] for name in ("SystemRoot", "TEMP", "TMP") if name in os.environ}
        env["DSH_FIXTURE_SCENARIO"] = self.scenario
        process = subprocess.Popen(
            [sys.executable, "-I", str(FIXTURE_PEER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.children.append(process)
        return process


def envelope(**changes):
    return replace(RunEnvelope(
        run_id=str(uuid.uuid4()), task_id="synthetic-task", session_id="synthetic-session",
        prompt="请审查合成契约。", task_spec={"task_id": "synthetic-task", "project_id": "synthetic"},
        manifest={"id": "manifest-v1", "version": 1, "items": [{"source_id": "synthetic-v1", "source_version": "v1", "content": "合成资料。"}]},
        max_output_tokens=128, timeout_seconds=1,
    ), **changes)


def run_fixture(scenario, **settings):
    adapter = FixtureAdapter(scenario, **settings)
    recorded = []
    result = adapter.run(envelope(), lambda kind, details: recorded.append((kind, details)), threading.Event())
    assert adapter._processes == {} and adapter._cancel_signals == {}
    assert all(child.poll() is not None for child in adapter.children)
    return result, recorded


@pytest.mark.parametrize("scenario", [
    "normal", "notifications_before_receipt", "idle_before_output", "duplicate_events",
    "duplicate_initialize", "old_turn_then_current", "foreign_child_noise", "malformed_lines",
])
def test_completed_result_requires_exact_receipt_turn_and_idle(scenario):
    result, recorded = run_fixture(scenario)
    assert result.text == "合成 stdio 结果：完成关联成功。"
    assert result.harness_message_id == "user-current"
    assert result.metadata["synthetic"] is True
    assert result.metadata["runtime_shutdown_graceful"] is True
    assert sum(kind == "runtime.prompt_dispatched" for kind, _ in recorded) == 1
    assert sum(kind == "runtime.message_enqueued" for kind, _ in recorded) == 1
    assert "HIDDEN" not in json.dumps(result.metadata) + result.text + json.dumps(recorded)


@pytest.mark.parametrize("scenario,code,unknown", [
    ("bad_handshake", "DSH_HANDSHAKE_IDENTITY_MISMATCH", False),
    ("bad_version", "DSH_HANDSHAKE_IDENTITY_MISMATCH", False),
    ("initialize_error", "DSH_INITIALIZE_FAILED", False),
    ("disconnect_before_init", "DSH_STDIO_DISCONNECTED", False),
    ("prompt_error", "DSH_PROMPT_REJECTED", True),
    ("invalid_receipt", "DSH_ENQUEUE_RECEIPT_INVALID", True),
    ("receipt_conflict", "DSH_ENQUEUE_RECEIPT_CONFLICT", True),
    ("disconnect_after_prompt", "DSH_STDIO_DISCONNECTED", True),
    ("disconnect_after_receipt", "DSH_STDIO_DISCONNECTED", True),
    ("receipt_only", "DSH_RUN_TIMEOUT", True),
    ("hang", "DSH_RUN_TIMEOUT", True),
    ("wrong_session", "DSH_RUN_TIMEOUT", True),
    ("wrong_message", "DSH_RUN_TIMEOUT", True),
    ("no_idle", "DSH_RUN_TIMEOUT", True),
    ("no_turn_end", "DSH_RUN_TIMEOUT", True),
    ("missing_text", "DSH_RUN_TIMEOUT", True),
    ("turn_error", "DSH_TURN_FAILED", False),
    ("turn_max_tokens", "DSH_OUTPUT_TOKEN_LIMIT", False),
    ("turn_blocked", "DSH_TURN_BLOCKED", False),
    ("turn_aborted", "DSH_TURN_ABORTED", False),
    ("interrupted", "DSH_ASSISTANT_INTERRUPTED", True),
    ("child_started", "DSH_SUBAGENT_NOT_ALLOWED", True),
    ("tool_call", "DSH_TOOL_NOT_ALLOWED", True),
    ("tool_header", "DSH_TOOL_NOT_ALLOWED", True),
    ("tool_block", "DSH_TOOL_NOT_ALLOWED", True),
    ("multiple_steps", "DSH_MODEL_CALL_LIMIT", True),
    ("retry", "DSH_RETRY_NOT_ALLOWED", True),
    ("server_request", "DSH_SERVER_REQUEST_UNSUPPORTED", True),
    ("oversize_frame", "DSH_FRAME_LIMIT", True),
    ("output_limit", "DSH_OUTPUT_BYTE_LIMIT", True),
    ("sequence_conflict", "DSH_EVENT_SEQUENCE_CONFLICT", True),
])
def test_faults_fail_closed_and_always_reap_owned_child(scenario, code, unknown):
    adapter = FixtureAdapter(scenario)
    recorded = []
    with pytest.raises(RuntimeFailure) as failure:
        adapter.run(envelope(), lambda kind, details: recorded.append((kind, details)), threading.Event())
    assert failure.value.code == code
    assert failure.value.outcome_unknown is unknown
    assert adapter._processes == {} and adapter._cancel_signals == {}
    assert all(child.poll() is not None for child in adapter.children)
    assert not any(kind == "runtime.turn_completed" for kind, _ in recorded)


def test_missing_shutdown_ack_does_not_leak_process_or_invent_graceful_exit():
    result, _ = run_fixture("shutdown_hang")
    assert result.metadata["runtime_shutdown_graceful"] is False


def test_closed_child_pipe_error_does_not_mask_result_or_leave_owned_run():
    class ClosingPipe:
        def __init__(self, pipe):
            self.pipe = pipe
        def write(self, value):
            return self.pipe.write(value)
        def flush(self):
            return self.pipe.flush()
        def close(self):
            self.pipe.close()
            raise OSError(22, "synthetic already-closed Windows pipe")
    class ClosingAdapter(FixtureAdapter):
        def _launch_process(self, request):
            child = super()._launch_process(request)
            child.stdin = ClosingPipe(child.stdin)
            return child
    adapter = ClosingAdapter()
    result = adapter.run(envelope(), lambda *_: None, threading.Event())
    assert result.text == "合成 stdio 结果：完成关联成功。"
    assert adapter._processes == {} and adapter._cancel_signals == {}
    assert all(child.poll() is not None for child in adapter.children)


def test_cancel_during_first_rpc_write_is_not_misclassified_as_pipe_failure():
    cancel_event = threading.Event()
    class CancellingPipe:
        def __init__(self, pipe):
            self.pipe = pipe
        def write(self, value):
            cancel_event.set()
            raise BrokenPipeError("synthetic child cancelled before initialize write")
        def flush(self):
            return self.pipe.flush()
        def close(self):
            return self.pipe.close()
    class CancellingAdapter(FixtureAdapter):
        def _launch_process(self, request):
            child = super()._launch_process(request)
            child.stdin = CancellingPipe(child.stdin)
            return child
    adapter = CancellingAdapter("hang")
    with pytest.raises(RunCancelled, match="RUN_CANCELLED"):
        adapter.run(envelope(), lambda *_: None, cancel_event)
    assert adapter._processes == {} and adapter._cancel_signals == {}
    assert all(child.poll() is not None for child in adapter.children)


def test_initialize_uses_pinned_provider_and_smaller_global_output_budget():
    result, _ = run_fixture("inspect_initialize", max_tokens=64)
    initialization = json.loads(result.text)
    assert initialization["provider"] == "deepseek-official"
    assert initialization["model"] == "deepseek-flash"
    assert initialization["maxTokens"] == 64
    assert set(initialization) == {"cwd", "provider", "model", "maxTokens"}


def test_stderr_is_only_hashed_and_not_saved_as_secret_or_reasoning():
    result, recorded = run_fixture("stderr_secret")
    assert "SYNTHETIC_SECRET" not in json.dumps(recorded) + result.text
    assert any(kind == "runtime.diagnostic" for kind, _ in recorded)


def test_cancel_targets_only_exact_owned_run():
    adapter = FixtureAdapter("hang")
    one, two = envelope(), envelope(session_id="other-target-session")
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(adapter.run, one, lambda *_: None, threading.Event())
        second = executor.submit(adapter.run, two, lambda *_: None, threading.Event())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with adapter._lock:
                if len(adapter._processes) == 2:
                    other = adapter._processes[two.run_id]
                    break
            time.sleep(0.005)
        else:
            raise AssertionError("fixture children not registered")
        adapter.cancel("not-owned-run")
        assert other.poll() is None
        adapter.cancel(one.run_id)
        with pytest.raises(RunCancelled):
            first.result(timeout=3)
        assert other.poll() is None
        adapter.cancel(two.run_id)
        with pytest.raises(RunCancelled):
            second.result(timeout=3)
    assert adapter._processes == {}


def test_precancel_and_oversize_prompt_launch_no_process():
    adapter = FixtureAdapter(max_prompt_bytes=1024)
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(RunCancelled):
        adapter.run(envelope(), lambda *_: None, cancelled)
    with pytest.raises(RuntimeFailure, match="DSH_PROMPT_BYTE_LIMIT"):
        adapter.run(envelope(prompt="文" * 1000), lambda *_: None, threading.Event())
    assert adapter.children == []


def test_direct_real_adapter_cannot_bypass_authorization_or_start_node():
    adapter = DshStdioAdapter(CollaborationSettings())
    with pytest.raises(RuntimeFailure, match="REAL_HARNESS_CALLS_NOT_AUTHORIZED"):
        adapter.run(envelope(), lambda *_: None, threading.Event())
    assert adapter._processes == {}


@pytest.fixture
def stdio_service():
    db_path = ROOT / "data" / f".test-collaboration-stdio-{uuid.uuid4()}.db"
    engine, factory = create_collaboration_database(f"sqlite:///{db_path}")
    init_collaboration_database(engine)
    adapter = FixtureAdapter("inspect_history")
    service = CollaborationService(factory, adapter)
    yield service, adapter
    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)


def task_request(source_id="synthetic-one"):
    return CreateTaskRequest(project_id="synthetic", title="stdio 合成任务", objective="验证历史重建", acceptance_criteria=["引用同任务历史"],
                             context_items=[{"layer": "project_baseline", "source_id": source_id,
                                             "source_version": "v1", "classification": "synthetic", "content": "合成基线。"}])


def execute(service, run):
    assert service.claim_next_run() == run["id"]
    service.execute_run(run["id"])
    done = service.get_run(run["id"])
    assert done["status"] == "WAITING_REVIEW", done
    return done, json.loads(done["artifacts"][0]["payload"]["text"])


def test_followup_after_new_adapter_replays_only_same_task_completed_history(stdio_service):
    service, adapter = stdio_service
    task_id = service.create_task(task_request())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="用户已决定保留只读", manifest_version=1), "first")
    first_done, first_body = execute(service, first)
    assert first_body["history"] == []
    # Another task must never enter this task's replay.
    other_task = service.create_task(task_request("foreign-source"))["task"]["id"]
    other, _ = service.create_run(other_task, CreateRunRequest(prompt="FOREIGN_TASK_SENTINEL", manifest_version=1), "other")
    execute(service, other)
    fresh_adapter = FixtureAdapter("inspect_history")
    resumed = CollaborationService(service.session_factory, fresh_adapter)
    followup, _ = resumed.append_message(task_id, FollowUpRequest(content="沿用前一轮限制", manifest_version=1), "follow")
    done, received = execute(resumed, followup["run"])
    assert done["harness_session_id"] != first_done["harness_session_id"]
    assert len(received["history"]) == 2
    assert [message["role"] for message in received["history"]] == ["user", "assistant"]
    assert received["history"][0]["content"] == "用户已决定保留只读"
    assert received["history"][1]["interpretation"] == "unverified_model_candidate"
    assert "FOREIGN" not in json.dumps(received)
    assert received["history_policy"]["native_session_restore_verified"] is False
    assert any(event["event"] == "runtime.context_prepared" for event in resumed.get_events(done["id"]))


def test_new_manifest_removes_old_history_instead_of_reauthorizing_it(stdio_service):
    service, _ = stdio_service
    task_id = service.create_task(task_request())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="OLD_AUTHORIZATION_SENTINEL", manifest_version=1), "old")
    execute(service, first)
    service.create_manifest(task_id, CreateManifestRequest(expected_current_version=1,
                            context_items=task_request("new-source").context_items), "new-manifest")
    second, _ = service.append_message(task_id, FollowUpRequest(content="仅使用新清单", manifest_version=2), "new")
    _, received = execute(service, second["run"])
    assert received["history"] == []
    assert received["history_policy"]["omitted_runs"] == 1
    assert received["context_ids"] == ["new-source"]


def test_unknown_outcome_is_not_replayed_as_finished_content(stdio_service):
    service, adapter = stdio_service
    task_id = service.create_task(task_request())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="UNCONFIRMED_SENTINEL", manifest_version=1), "unknown")
    adapter.scenario = "disconnect_after_receipt"
    assert service.claim_next_run() == first["id"]
    service.execute_run(first["id"])
    assert service.get_run(first["id"])["status"] == "OUTCOME_UNKNOWN"
    adapter.scenario = "inspect_history"
    follow, _ = service.append_message(task_id, FollowUpRequest(content="独立新请求", manifest_version=1), "next")
    _, received = execute(service, follow["run"])
    assert received["history"] == []
    assert received["history_policy"]["omitted_runs"] == 1


def test_history_overflow_fails_before_dispatch_without_stranding_running_run(stdio_service):
    service, adapter = stdio_service
    task_id = service.create_task(task_request())["task"]["id"]
    first, _ = service.create_run(task_id, CreateRunRequest(prompt="文" * 24_000, manifest_version=1), "large-history")
    execute(service, first)
    count = len(adapter.children)
    follow, _ = service.append_message(task_id, FollowUpRequest(content="超限历史", manifest_version=1), "follow")
    assert service.claim_next_run() == follow["run"]["id"]
    service.execute_run(follow["run"]["id"])
    failed = service.get_run(follow["run"]["id"])
    assert failed["status"] == "FAILED" and failed["outcome_code"] == "DSH_HISTORY_BYTE_LIMIT"
    assert len(adapter.children) == count


def test_profile_prepare_refuses_home_override_outside_data_and_path_traversal():
    adapter = FixtureAdapter()
    with pytest.raises(RuntimeFailure, match="DSH_RUNTIME_PATH_OUTSIDE_OWNED_DATA"):
        adapter._prepare_home(home=ROOT, workspace=ROOT / "data" / "unused")
    with pytest.raises(ValueError, match="COLLABORATION_PROFILE_INVALID"):
        replace(CollaborationSettings(), profile_name="../other").validate()


def test_pinned_installation_metadata_and_dedicated_profile_are_verified_without_starting_harness():
    directory = ROOT / "data" / f".test-collaboration-profile-{uuid.uuid4()}"
    adapter = DshStdioAdapter(replace(CollaborationSettings(), dsh_home=directory / "home", workspace=directory / "workspace"))
    try:
        adapter._verify_runtime()  # package.json only, never launcher or model
        adapter._prepare_home()
        profile = directory / "home" / "profiles" / adapter.settings.profile_name
        patch = (profile / "cordis.patch.yml").read_text(encoding="utf-8")
        for entry in DISABLED_PROFILE_ENTRIES:
            assert f"id: {entry}\n  disabled: true" in patch
        assert "thinking: disabled" in patch and "reasoningEffort: off" in patch
        (directory / "home" / "cordis.patch.yml").write_text("[]", encoding="utf-8")
        with pytest.raises(RuntimeFailure, match="DSH_HOME_NOT_EXCLUSIVE"):
            adapter._prepare_home()
    finally:
        if directory.exists() and directory.parent == ROOT / "data" and directory.name.startswith(".test-collaboration-profile-"):
            shutil.rmtree(directory)
