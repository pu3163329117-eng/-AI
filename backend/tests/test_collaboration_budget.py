"""Synthetic rollout permits: all rejection tests stop before process launch."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil
import threading
import uuid

import pytest

from backend.config import ROOT
from backend.collaboration.budget_runtime import BudgetedDshStdioAdapter
from backend.collaboration.config import CollaborationSettings, load_settings
from backend.collaboration.runtime import AdapterResult, DshStdioAdapter, RunEnvelope, RuntimeFailure, RunCancelled
from backend.collaboration.synthetic_budget import CANDIDATE, PROMPTS, SHORT_PROMPT, load_policy, make_policy, task_request, validate_envelope


def request_envelope(scenario="first"):
    request = task_request()
    task_id, manifest_id = str(uuid.uuid4()), str(uuid.uuid4())
    history = []
    if scenario == "followup":
        for role, content in [("user", PROMPTS["first"]), ("assistant", json.dumps(CANDIDATE, ensure_ascii=False))]:
            history.append({"role": role, "content": content, "input_manifest_id": manifest_id,
                            "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                            "interpretation": "user_request" if role == "user" else "unverified_model_candidate"})
    return RunEnvelope(run_id=str(uuid.uuid4()), task_id=task_id, session_id=f"collab-{task_id}",
                       prompt=PROMPTS[scenario], task_spec={"task_id": task_id, **{key: request[key] for key in (
                           "project_id", "title", "objective", "acceptance_criteria", "forbidden_actions")}},
                       manifest={"id": manifest_id, "task_id": task_id, "version": 1, "items": request["context_items"],
                                 "truncated": False, "authorization_scope": {"classifications": ["synthetic"], "read_only": True,
                                 "learner_records": False, "shell": False, "publish": False, "approval": False}},
                       max_output_tokens=128, timeout_seconds=60, history=history)


@pytest.fixture
def permit_dir():
    directory = ROOT / "output" / "harness-backend-20261015" / f"unit-{uuid.uuid4()}"
    directory.mkdir(parents=True)
    yield directory
    assert directory.parent == ROOT / "output" / "harness-backend-20261015" and directory.name.startswith("unit-")
    shutil.rmtree(directory)


@pytest.mark.parametrize("scenario", list(PROMPTS))
def test_only_the_four_synthetic_scenarios_are_valid(scenario):
    assert validate_envelope(request_envelope(scenario)) == scenario


@pytest.mark.parametrize("change", ["task", "content", "classification", "version", "scope", "tokens", "timeout", "prompt", "history"])
def test_unapproved_scope_or_budget_is_rejected(change):
    envelope = request_envelope()
    if change == "task": envelope.task_spec["title"] = "UNAPPROVED"
    elif change == "content": envelope.manifest["items"][0]["content"] += "PRIVATE"
    elif change == "classification": envelope.manifest["items"][0]["classification"] = "project_non_sensitive"
    elif change == "version": envelope.manifest["version"] = 2
    elif change == "scope": envelope.manifest["authorization_scope"]["shell"] = True
    elif change == "tokens": envelope = replace(envelope, max_output_tokens=129)
    elif change == "timeout": envelope = replace(envelope, timeout_seconds=61)
    elif change == "prompt": envelope = replace(envelope, prompt="UNAPPROVED_REQUEST")
    elif change == "history": envelope.history.append({"content": "FOREIGN_HISTORY"})
    with pytest.raises(RuntimeFailure):
        validate_envelope(envelope)


@pytest.mark.parametrize("change", ["source", "candidate", "content_hash", "user_request"])
def test_followup_history_cannot_expand_access_or_include_other_manifests(change):
    envelope = request_envelope("followup")
    if change == "source": envelope.history[0]["input_manifest_id"] = "foreign-manifest"
    elif change == "candidate": envelope.history[1]["content"] = '{"candidate":"甲"}'
    elif change == "content_hash": envelope.history[0]["content_sha256"] = "wrong"
    else: envelope.history[0]["content"] = "FOREIGN_REQUEST"
    with pytest.raises(RuntimeFailure, match="DSH_SYNTHETIC_HISTORY_DENIED"):
        validate_envelope(envelope)


def test_real_backend_requires_a_budget_policy():
    with pytest.raises(RuntimeFailure, match="DSH_BUDGET_POLICY_REQUIRED"):
        BudgetedDshStdioAdapter(CollaborationSettings())


@pytest.mark.parametrize("field,value", [("max_calls", 5), ("max_output_tokens", 129), ("automatic_retries", 1), ("authorization_status", "YES")])
def test_mutated_budget_or_authorization_is_not_accepted(permit_dir, field, value):
    policy = make_policy("execute")
    policy[field] = value
    path = permit_dir / "policy.json"
    path.write_text(json.dumps(policy), encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="DSH_SYNTHETIC_POLICY_INVALID"):
        load_policy(path)


def test_restart_keeps_spent_scenario_and_refuses_before_any_child(permit_dir, monkeypatch):
    policy = permit_dir / "policy.json"
    policy.write_text(json.dumps(make_policy()), encoding="utf-8")
    settings = replace(CollaborationSettings(), budget_policy_path=policy)
    first = BudgetedDshStdioAdapter(settings)
    (first.ledger / "first.json").write_text('{"status":"DISPATCH_RESERVED"}', encoding="utf-8")
    def forbidden(*args, **kwargs):
        pytest.fail("a spent or changed permit must not launch a child")
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", forbidden)
    resumed = BudgetedDshStdioAdapter(settings)
    with pytest.raises(RuntimeFailure, match="DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY"):
        resumed.run(request_envelope(), lambda *_: None, threading.Event())
    policy.write_text(json.dumps(make_policy(), indent=2), encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="DSH_BUDGET_POLICY_CHANGED"):
        resumed.run(request_envelope(), lambda *_: None, threading.Event())


def test_budget_policy_path_is_explicitly_loaded():
    path = ROOT / "output" / "harness-backend-20261015" / "unused.json"
    assert load_settings({"WENYAN_COLLABORATION_BUDGET_POLICY_PATH": str(path)}).budget_policy_path == path


def test_continuation_followup_only_accepts_the_new_completed_task_history():
    request = request_envelope("followup")
    with pytest.raises(RuntimeFailure, match="DSH_SYNTHETIC_HISTORY_DENIED"):
        validate_envelope(request, continuation=True)
    request.history[0]["content"] = PROMPTS["interrupted"]
    request.history[0]["content_sha256"] = hashlib.sha256(PROMPTS["interrupted"].encode("utf-8")).hexdigest()
    assert validate_envelope(request, continuation=True) == "followup"
    with pytest.raises(RuntimeFailure, match="DSH_SYNTHETIC_HISTORY_DENIED"):
        validate_envelope(request)


def continuation_permit(directory):
    ledger = directory / "attempts"
    ledger.mkdir()
    original_run = str(uuid.uuid4())
    first = ledger / "first.json"
    first.write_text(json.dumps({"status": "DISPATCH_RESERVED", "scenario": "first", "run_id": original_run}), encoding="utf-8")
    continuation = {"plan": "timeout_recovery_remaining_three", "original_run_id": original_run,
                    "first_attempt_sha256": hashlib.sha256(first.read_bytes()).hexdigest()}
    policy = directory / "continuation-policy.json"
    policy.write_text(json.dumps(make_policy(continuation=continuation)), encoding="utf-8")
    return policy, first


def test_continuation_refuses_replaced_or_deleted_original_lock_before_launch(permit_dir, monkeypatch):
    policy, first = continuation_permit(permit_dir)
    adapter = BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))
    def forbidden(*args, **kwargs):
        pytest.fail("continuation must not unlock an original attempt")
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", forbidden)
    first.write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="DSH_CONTINUATION_ORIGINAL_LOCK_CHANGED"):
        adapter._launch_process(request_envelope("interrupted"))
    first.unlink()
    with pytest.raises(RuntimeFailure, match="DSH_CONTINUATION_ORIGINAL_LOCK_CHANGED"):
        BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))


def test_new_task_slot_has_no_crash_barrier_but_shares_original_ledger(permit_dir, monkeypatch):
    policy, first = continuation_permit(permit_dir)
    original = first.read_bytes()
    adapter = BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))
    request = request_envelope("interrupted")
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", lambda *_: "no-process-test-only")
    control = adapter._control_dir(request.run_id)
    try:
        assert adapter._launch_process(request) == "no-process-test-only"
        config = json.loads((control / "guard.json").read_text(encoding="utf-8"))
        assert config["hold_after_headers"] is False and config["scenario_role"] == "new_task_after_unknown"
        assert config["attempt_file"] == str(first.parent / "interrupted.json")
        assert first.read_bytes() == original
    finally:
        assert control.parent == ROOT / "data" / "dsh-collaboration-controls" and control.name == request.run_id
        shutil.rmtree(control)


@pytest.mark.parametrize("change", ["hash", "run_id", "plan", "extra"])
def test_continuation_requires_exact_frozen_original_reference(change):
    continuation = {"plan": "timeout_recovery_remaining_three", "original_run_id": str(uuid.uuid4()), "first_attempt_sha256": "0" * 64}
    if change == "hash": continuation["first_attempt_sha256"] = "not-a-digest"
    elif change == "run_id": continuation["original_run_id"] = "../outside"
    elif change == "plan": continuation["plan"] = "RESET_BUDGET"
    else: continuation["extra"] = "NOT_AUTHORIZED"
    with pytest.raises(ValueError, match="SYNTHETIC_CONTINUATION_INVALID"):
        make_policy(continuation=continuation)


def remaining_permit(directory):
    ledger = directory / "attempts"
    ledger.mkdir()
    locks = {}
    for scenario in ("first", "interrupted"):
        run = str(uuid.uuid4())
        path = ledger / f"{scenario}.json"
        path.write_text(json.dumps({"status": "DISPATCH_RESERVED", "scenario": scenario, "run_id": run}), encoding="utf-8")
        locks[scenario] = {"run_id": run, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    permit = {"plan": "remaining_two_180s", "locks": locks}
    path = directory / "remaining.json"
    path.write_text(json.dumps(make_policy(remaining_two=permit)), encoding="utf-8")
    return path, permit


@pytest.mark.parametrize("scenario,slot", [("first", "followup"), ("followup", "cancel")])
def test_remaining_two_maps_only_new_synthetic_requests_to_unused_slots(scenario, slot):
    envelope = replace(request_envelope(scenario), timeout_seconds=180)
    assert validate_envelope(envelope, remaining_two=True) == slot
    with pytest.raises(RuntimeFailure, match="BUDGET_EXCEEDED"):
        validate_envelope(envelope)
    with pytest.raises(RuntimeFailure, match="BUDGET_EXCEEDED"):
        validate_envelope(replace(envelope, timeout_seconds=181), remaining_two=True)


@pytest.mark.parametrize("scenario", ["cancel", "interrupted"])
def test_remaining_two_rejects_other_scenarios(scenario):
    with pytest.raises(RuntimeFailure, match="REQUEST_DENIED"):
        validate_envelope(request_envelope(scenario), remaining_two=True)


@pytest.mark.parametrize("scenario", ["first", "interrupted"])
def test_remaining_two_locks_are_both_immutable(permit_dir, monkeypatch, scenario):
    policy, _ = remaining_permit(permit_dir)
    settings = replace(CollaborationSettings(), budget_policy_path=policy)
    adapter = BudgetedDshStdioAdapter(settings)
    assert adapter.settings.run_timeout_seconds == 180
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", lambda *_: pytest.fail("no launch"))
    (permit_dir / "attempts" / f"{scenario}.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="ORIGINAL_LOCK_CHANGED"):
        adapter.run(replace(request_envelope(), timeout_seconds=180), lambda *_: None, threading.Event())


def test_180_requires_explicit_two_lock_permit(permit_dir):
    policy, _ = remaining_permit(permit_dir)
    raw = json.loads(policy.read_text(encoding="utf-8"))
    del raw["remaining_two"]
    policy.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="POLICY_INVALID"):
        load_policy(policy)


def test_remaining_followup_cancel_discards_verified_model_result(permit_dir, monkeypatch):
    policy, _ = remaining_permit(permit_dir)
    adapter = BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))
    envelope = replace(request_envelope("followup"), timeout_seconds=180)
    control = adapter._control_dir(envelope.run_id)
    control.mkdir(parents=True)
    (control / "transport.json").write_text("{}", encoding="utf-8")
    cancelled = threading.Event()
    cancelled.set()
    monkeypatch.setattr(DshStdioAdapter, "run", lambda *_: AdapterResult(json.dumps(CANDIDATE), "synthetic-id", {"history_messages": 2}))
    try:
        with pytest.raises(RunCancelled):
            adapter.run(envelope, lambda *_: None, cancelled)
        assert json.loads((control / "completion-checkpoint.json").read_text(encoding="utf-8"))["candidate"] == CANDIDATE
    finally:
        assert control.parent == ROOT / "data" / "dsh-collaboration-controls" and control.name == envelope.run_id
        shutil.rmtree(control)


def last_permit(directory):
    path, permit = remaining_permit(directory)
    prior = directory / "attempts" / "followup.json"
    run = str(uuid.uuid4())
    prior.write_text(json.dumps({"status": "DISPATCH_RESERVED", "scenario": "followup", "run_id": run}), encoding="utf-8")
    permit["plan"] = "last_one_short_output_180s"
    permit["locks"]["followup"] = {"run_id": run, "sha256": hashlib.sha256(prior.read_bytes()).hexdigest()}
    path.write_text(json.dumps(make_policy(last_one=permit)), encoding="utf-8")
    return path, permit


def test_last_one_accepts_only_short_prompt_with_zero_history():
    request = replace(request_envelope(), prompt=SHORT_PROMPT, timeout_seconds=180)
    assert validate_envelope(request, last_one=True) == "cancel"
    with pytest.raises(RuntimeFailure):
        validate_envelope(request)
    for changed in (replace(request, prompt=PROMPTS["first"]), replace(request, timeout_seconds=181),
                    replace(request, max_output_tokens=129), replace(request, history=[{"role": "user"}])):
        with pytest.raises(RuntimeFailure):
            validate_envelope(changed, last_one=True)


@pytest.mark.parametrize("scenario", ["first", "interrupted", "followup"])
def test_last_one_cannot_change_any_prior_lock(permit_dir, monkeypatch, scenario):
    policy, _ = last_permit(permit_dir)
    adapter = BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", lambda *_: pytest.fail("no launch"))
    (permit_dir / "attempts" / f"{scenario}.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="ORIGINAL_LOCK_CHANGED"):
        adapter.run(replace(request_envelope(), prompt=SHORT_PROMPT, timeout_seconds=180), lambda *_: None, threading.Event())


def test_last_one_stays_spent_after_restart(permit_dir, monkeypatch):
    policy, _ = last_permit(permit_dir)
    (permit_dir / "attempts" / "cancel.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(DshStdioAdapter, "_launch_process", lambda *_: pytest.fail("no launch"))
    adapter = BudgetedDshStdioAdapter(replace(CollaborationSettings(), budget_policy_path=policy))
    with pytest.raises(RuntimeFailure, match="ALREADY_RESERVED_NO_RETRY"):
        adapter.run(replace(request_envelope(), prompt=SHORT_PROMPT, timeout_seconds=180), lambda *_: None, threading.Event())


@pytest.mark.parametrize("change", ["plan", "missing_lock", "hash", "extra", "short_prompt"])
def test_last_one_permit_is_exact_and_cannot_expand(permit_dir, change):
    path, _ = last_permit(permit_dir)
    raw = json.loads(path.read_text(encoding="utf-8"))
    if change == "plan": raw["last_one"]["plan"] = "NEW_BUDGET"
    elif change == "missing_lock": del raw["last_one"]["locks"]["followup"]
    elif change == "hash": raw["last_one"]["locks"]["first"]["sha256"] = "bad"
    elif change == "extra": raw["last_one"]["extra"] = True
    else: raw["short_prompt"] = "UNAPPROVED"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(RuntimeFailure, match="POLICY_INVALID"):
        load_policy(path)
