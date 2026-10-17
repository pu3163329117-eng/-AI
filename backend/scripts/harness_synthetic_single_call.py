"""Run the frozen synthetic packet once, with an independent guarded Harness.

Offline mode boots the real pinned Harness but replaces fetch with synthetic
SSE and cannot send a provider request. Execute mode needs explicit authority.
No personal sessions, config, .env, learner records, or running service writes.
"""
from dataclasses import replace
import argparse
import json
import os
from pathlib import Path
import secrets
import threading
import time
import uuid

from backend.config import ROOT
from backend.collaboration.config import CollaborationSettings
from backend.collaboration.runtime import DshStdioAdapter, RuntimeFailure
from backend.scripts.harness_stdio_preview import synthetic_packet, validate_existing_packet


class GuardedAdapter(DshStdioAdapter):
    def __init__(self, settings, config_file):
        super().__init__(settings)
        self.config_file = config_file

    def _environment(self, **kwargs):
        env = super()._environment(**kwargs)
        guard = Path(__file__).with_name("harness_single_call_guard.cjs").as_posix()
        env["NODE_OPTIONS"] = f'--require "{guard}"'
        env["WENYAN_SINGLE_CALL_CONFIG"] = str(self.config_file)
        return env


def resolve_credential(args):
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key, "process_environment"
    if not args.allow_personal_credential or args.credential_file is None:
        raise RuntimeFailure("DSH_CREDENTIAL_NOT_CONFIGURED")
    # Only an explicitly authorized exact file, one named reference, no scans,
    # fallback .env layers, logging, credential copying, or persistent changes.
    import yaml
    try:
        document = yaml.safe_load(args.credential_file.read_text(encoding="utf-8"))
        key = document["refs"]["DEEPSEEK_API_KEY"]
        if document.get("version") != 1 or not isinstance(key, str) or not key.strip():
            raise ValueError()
        return key.strip(), "authorized_local_harness_reference"
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError):
        raise RuntimeFailure("DSH_AUTHORIZED_CREDENTIAL_UNAVAILABLE") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("offline", "execute"), default="offline")
    parser.add_argument("--allow-personal-credential", action="store_true")
    parser.add_argument("--credential-file", type=Path)
    args = parser.parse_args()
    base = ROOT / "output" / "harness-real-synthetic-20261014"
    base.mkdir(parents=True, exist_ok=True)
    packet_path = ROOT / "output" / "harness-stdio-offline-20261014" / "synthetic-integration-packet.json"
    packet = json.loads(packet_path.read_text(encoding="utf-8"))
    validate_existing_packet(packet)
    attempt_file = base / "model-attempt.json"
    if args.mode == "execute" and attempt_file.exists():
        raise RuntimeFailure("SINGLE_CALL_ALREADY_RESERVED_NO_RETRY")
    if args.mode == "offline":
        key, key_source = "synthetic-offline-not-a-real-key", "synthetic_offline"
        output = base / f"offline-{uuid.uuid4()}"
    else:
        key, key_source = resolve_credential(args)
        output = base / "single-call"
    output.mkdir(parents=True, exist_ok=False)
    run_id = str(uuid.uuid4())
    envelope = replace(synthetic_packet(), run_id=run_id, session_id=f"collab-synthetic-{run_id}")
    settings = replace(CollaborationSettings(), enabled=True, token=secrets.token_urlsafe(32),
                       runtime="dsh-stdio", real_calls_enabled=True, max_tokens=128,
                       run_timeout_seconds=60, max_prompt_bytes=8192, max_output_bytes=8192)
    config_file = output / "guard-config.json"
    config_file.write_text(json.dumps({"mode": args.mode, "prompt": packet["prompt"],
                                     "observation_file": str(output / "transport.json"),
                                     "attempt_file": str(attempt_file)}, ensure_ascii=False), encoding="utf-8")
    report = {"status": "PREPARING", "mode": args.mode, "run_id": run_id,
              "prompt_sha256": packet["prompt_sha256"], "prompt_bytes": packet["prompt_bytes"],
              "credential_source": key_source, "max_output_tokens": 128, "timeout_seconds": 60,
              "automatic_retries": 0, "artifact_status": "CANDIDATE", "events": []}
    report_file = output / "result.json"

    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    def emit(kind, details):
        report["events"].append({"event": kind, "details": details})
        save()

    adapter = GuardedAdapter(settings, config_file)
    adapter.synthetic = args.mode == "offline"
    old_key = os.environ.get("DEEPSEEK_API_KEY")
    started = time.monotonic()
    try:
        os.environ["DEEPSEEK_API_KEY"] = key
        save()
        result = adapter.run(envelope, emit, threading.Event())
        report.update(status="OFFLINE_PASS" if args.mode == "offline" else "WAITING_REVIEW",
                      text=result.text, harness_message_id=result.harness_message_id, metadata=result.metadata)
        try:
            candidate = json.loads(result.text)
        except ValueError:
            report.update(candidate_matches=False, candidate_parse_status="INVALID_JSON")
        else:
            report["candidate_matches"] = candidate == {"candidate": "乙", "source_id": "synthetic/harness-first-integration", "review_status": "CANDIDATE"}
    except RuntimeFailure as failure:
        report.update(status="OUTCOME_UNKNOWN" if failure.outcome_unknown else "FAILED", outcome_code=failure.code)
    except Exception:
        # Never print raw provider, credential parser, or request exceptions.
        report.update(status="OUTCOME_UNKNOWN" if attempt_file.exists() else "FAILED", outcome_code="SINGLE_CALL_EXECUTION_ERROR")
    finally:
        if old_key is None:
            os.environ.pop("DEEPSEEK_API_KEY", None)
        else:
            os.environ["DEEPSEEK_API_KEY"] = old_key
        key = ""
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["prompt_dispatches"] = sum(event["event"] == "runtime.prompt_dispatched" for event in report["events"])
        transport_file = output / "transport.json"
        report["transport"] = json.loads(transport_file.read_text(encoding="utf-8")) if transport_file.exists() else {"provider_fetch_attempts": 0}
        save()
    print(json.dumps({"status": report["status"], "outcome_code": report.get("outcome_code"),
                      "prompt_dispatches": report["prompt_dispatches"], "transport": report["transport"],
                      "candidate_matches": report.get("candidate_matches"), "report_path": str(report_file)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
