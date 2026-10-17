"""Budgeted real Harness entry point used by the backend controller."""
from dataclasses import replace
import hashlib
import json
import os
import time
import uuid

from .runtime import AdapterResult, DshStdioAdapter, RuntimeFailure
from .synthetic_budget import load_policy, validate_envelope
from .synthetic_budget import CANDIDATE
from .errors import RunCancelled
try:
    from backend.config import ROOT
except ModuleNotFoundError:
    from config import ROOT


class BudgetedDshStdioAdapter(DshStdioAdapter):
    def __init__(self, settings):
        if settings.budget_policy_path is None:
            raise RuntimeFailure("DSH_BUDGET_POLICY_REQUIRED")
        policy_path = settings.budget_policy_path
        if not policy_path.is_absolute() or not policy_path.resolve().is_relative_to((ROOT / "output").resolve()):
            raise RuntimeFailure("DSH_BUDGET_POLICY_PATH_DENIED")
        for component in (policy_path, *policy_path.parents):
            if component.is_symlink() or component.is_junction():
                raise RuntimeFailure("DSH_BUDGET_POLICY_LINK_DENIED")
        self.policy, self.policy_sha256 = load_policy(policy_path)
        self.policy_path = policy_path
        self.ledger = policy_path.parent / "attempts"
        if self.ledger.is_symlink() or self.ledger.is_junction():
            raise RuntimeFailure("DSH_BUDGET_LEDGER_LINK_DENIED")
        self.ledger.mkdir(exist_ok=True)
        self._verify_continuation()
        self.synthetic = self.policy["transport"] == "offline"
        super().__init__(replace(settings, max_tokens=min(settings.max_tokens, 128),
                                 run_timeout_seconds=min(settings.run_timeout_seconds, self.policy["timeout_seconds"]),
                                 max_prompt_bytes=min(settings.max_prompt_bytes, 8192)))

    def _control_dir(self, run_id):
        try:
            uuid.UUID(run_id)
        except (ValueError, AttributeError):
            raise RuntimeFailure("DSH_RUN_ID_INVALID") from None
        return ROOT / "data" / "dsh-collaboration-controls" / run_id

    def _verify_continuation(self):
        remaining = self.policy.get("last_one") or self.policy.get("remaining_two")
        if remaining:
            try:
                for scenario, expected in remaining["locks"].items():
                    path = self.ledger / f"{scenario}.json"
                    if path.is_symlink() or path.is_junction():
                        raise ValueError()
                    raw = path.read_bytes()
                    entry = json.loads(raw)
                    if (hashlib.sha256(raw).hexdigest() != expected["sha256"] or entry["run_id"] != expected["run_id"]
                            or entry["scenario"] != scenario or entry["status"] != "DISPATCH_RESERVED"):
                        raise ValueError()
            except (OSError, ValueError, TypeError, KeyError):
                raise RuntimeFailure("DSH_CONTINUATION_ORIGINAL_LOCK_CHANGED") from None
        continuation = self.policy.get("continuation")
        if continuation is None:
            return
        try:
            first = self.ledger / "first.json"
            if first.is_symlink() or first.is_junction():
                raise ValueError()
            raw = first.read_bytes()
            entry = json.loads(raw)
            if (hashlib.sha256(raw).hexdigest() != continuation["first_attempt_sha256"]
                    or entry["run_id"] != continuation["original_run_id"]
                    or entry["scenario"] != "first" or entry["status"] != "DISPATCH_RESERVED"):
                raise ValueError()
        except (OSError, ValueError, TypeError, KeyError):
            raise RuntimeFailure("DSH_CONTINUATION_ORIGINAL_LOCK_CHANGED") from None

    def _environment(self, **kwargs):
        env = super()._environment(**kwargs)
        run_id = kwargs["home"].name
        guard = ROOT / "backend" / "scripts" / "harness_single_call_guard.cjs"
        env["NODE_OPTIONS"] = f'--require "{guard.as_posix()}"'
        env["WENYAN_SINGLE_CALL_CONFIG"] = str(self._control_dir(run_id) / "guard.json")
        return env

    def _launch_process(self, envelope):
        try:
            uuid.UUID(envelope.run_id)
        except (ValueError, AttributeError):
            raise RuntimeFailure("DSH_RUN_ID_INVALID") from None
        continuation = bool(self.policy.get("continuation"))
        remaining = bool(self.policy.get("remaining_two"))
        last_one = bool(self.policy.get("last_one"))
        scenario = validate_envelope(envelope, continuation=continuation, remaining_two=remaining, last_one=last_one)
        current, digest = load_policy(self.policy_path)
        if digest != self.policy_sha256 or current != self.policy:
            raise RuntimeFailure("DSH_BUDGET_POLICY_CHANGED")
        if self.ledger.is_symlink() or self.ledger.is_junction():
            raise RuntimeFailure("DSH_BUDGET_LEDGER_LINK_DENIED")
        self._verify_continuation()
        if (self.ledger / f"{scenario}.json").exists():
            raise RuntimeFailure("DSH_SCENARIO_ALREADY_RESERVED_NO_RETRY")
        directory = self._control_dir(envelope.run_id)
        self._verify_owned_path(directory)
        directory.mkdir(parents=True, exist_ok=False)
        config = {"mode": self.policy["transport"], "prompt": self._build_prompt(envelope),
                  "observation_file": str(directory / "transport.json"),
                  "attempt_file": str(self.ledger / f"{scenario}.json"), "scenario": scenario,
                  "grant_file": str(self.policy_path), "grant_sha256": self.policy_sha256,
                  "hold_after_headers": not (remaining or last_one) and (scenario == "cancel" or scenario == "interrupted" and not continuation),
                  "scenario_role": "last_one_short_output_180s" if last_one else ({"followup": "new_task_180s", "cancel": "followup_precommit_cancel_180s"}[scenario]
                                    if remaining else "new_task_after_unknown" if continuation and scenario == "interrupted" else scenario),
                  "owner_pid": os.getpid(), "run_id": envelope.run_id}
        (directory / "guard.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        return super()._launch_process(envelope)

    def run(self, envelope, emit, cancel_event):
        started = time.monotonic()
        observation = self._control_dir(envelope.run_id) / "transport.json"
        try:
            result = super().run(envelope, emit, cancel_event)
            transport = json.loads(observation.read_text(encoding="utf-8"))
            if self.policy.get("remaining_two") and envelope.prompt == self.policy["prompts"]["followup"]:
                # Explicit acceptance barrier: model has completed; cancellation
                # tests backend discard before candidate persistence, not provider abort.
                try:
                    if json.loads(result.text) != CANDIDATE:
                        raise ValueError()
                except ValueError:
                    raise RuntimeFailure("DSH_SYNTHETIC_CANDIDATE_MISMATCH") from None
                evidence = {"candidate": CANDIDATE, "harness_message_id": result.harness_message_id,
                            "metadata": result.metadata, "stage": "MODEL_COMPLETED_BEFORE_BACKEND_COMMIT"}
                checkpoint = observation.parent / "completion-checkpoint.json"
                temporary = checkpoint.with_suffix(".tmp")
                temporary.write_text(json.dumps(evidence, ensure_ascii=False), encoding="utf-8")
                temporary.replace(checkpoint)
                emit("runtime.precommit_cancel_ready", {"history_messages": len(envelope.history)})
                if cancel_event.wait(max(0, min(envelope.timeout_seconds, self.policy["timeout_seconds"]) - (time.monotonic() - started))):
                    raise RunCancelled("RUN_CANCELLED")
                raise RuntimeFailure("DSH_PRECOMMIT_CANCEL_NOT_RECEIVED")
            return AdapterResult(result.text, result.harness_message_id,
                                 {**result.metadata, "transport": transport, "budget_policy_sha256": self.policy_sha256})
        finally:
            if observation.exists():
                # The guard writes only bounded numeric/hash facts, never raw
                # frames, provider errors, prompt text, auth headers or keys.
                transport = json.loads(observation.read_text(encoding="utf-8"))
                emit("runtime.transport_observed", transport)
