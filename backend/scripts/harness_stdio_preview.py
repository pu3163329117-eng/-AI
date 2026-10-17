"""Prepare an inspectable synthetic packet and verify profile composition offline.

This command has no model-call path. It never reads credentials or personal
Harness configuration. A fresh owned test home is removed after the CLI dump.
"""
from dataclasses import replace
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from backend.config import ROOT
from backend.collaboration.config import CollaborationSettings, EXPECTED_DSH_VERSION
from backend.collaboration.runtime import DISABLED_PROFILE_ENTRIES, DshStdioAdapter, RunEnvelope


def synthetic_packet():
    content = "纯合成规则：甲、乙、丙中，仅乙符合候选条件。任何结果只作候选，不代表人工审核。"
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    source_id = "synthetic/harness-first-integration"
    task = {
        "task_id": "00000000-0000-4000-8000-000000000001", "project_id": "wenyan-synthetic-integration",
        "title": "第一次 Harness 合成联调", "objective": "仅依据合成规则返回候选及来源，检验固定版本 stdio 连接。",
        "acceptance_criteria": ["返回乙及指定来源", "输出保持候选状态", "入队消息与完成 turn 正确关联"],
        "forbidden_actions": ["访问文件", "执行工具", "发布或审核", "使用学习记录"],
    }
    manifest = {
        "id": "00000000-0000-4000-8000-000000000002", "task_id": task["task_id"], "version": 1,
        "items": [{"layer": "project_baseline", "source_id": source_id,
                   "source_version": f"sha256:{content_hash}", "classification": "synthetic", "content": content}],
        "authorization_scope": {"classifications": ["synthetic"], "read_only": True, "learner_records": False,
                                "shell": False, "publish": False, "approval": False},
        "truncated": False,
    }
    envelope = RunEnvelope(
        run_id="00000000-0000-4000-8000-000000000003", task_id=task["task_id"],
        session_id="collab-synthetic-first-integration", task_spec=task, manifest=manifest,
        prompt='仅返回 JSON：{"candidate":"乙","source_id":"synthetic/harness-first-integration","review_status":"CANDIDATE"}。不调用工具。',
        max_output_tokens=128, timeout_seconds=60,
        history=[], history_policy={"mode": "bridge_replay", "native_session_restore_verified": False,
                                   "same_task_only": True, "same_manifest_only": True,
                                   "model_candidates_grant_authority": False, "truncated": False},
    )
    return envelope


def validate_existing_packet(packet):
    """Reject changes to the approved preview, not merely a self-consistent hash."""
    expected = DshStdioAdapter._build_prompt(synthetic_packet())
    encoded = expected.encode("utf-8")
    required_budget = {"max_prompt_dispatches": 1, "max_output_tokens": 128,
                       "max_input_bytes": 8192, "max_seconds": 60, "automatic_retries": 0}
    if (packet.get("prompt") != expected or packet.get("prompt_bytes") != len(encoded)
            or packet.get("prompt_sha256") != hashlib.sha256(encoded).hexdigest()
            or packet.get("runtime_version") != EXPECTED_DSH_VERSION
            or packet.get("wire_server_version") != "0.0.1"
            or packet.get("provider") != "deepseek-official"
            or packet.get("model") != "deepseek-flash"
            or any(packet.get("budget", {}).get(key) != value for key, value in required_budget.items())):
        raise ValueError("SYNTHETIC_PACKET_CHANGED")
    return len(encoded), packet["prompt_sha256"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-existing-packet", action="store_true",
                        help="Read and verify the frozen packet; never overwrite it or call a model")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output" / "harness-stdio-offline-20261014")
    args = parser.parse_args()
    output = args.output_dir.absolute()
    if not output.resolve().is_relative_to((ROOT / "output").resolve()):
        raise ValueError("REPORT_PATH_OUTSIDE_OUTPUT")
    for component in (output, *output.parents):
        if component.is_symlink() or component.is_junction():
            raise ValueError("REPORT_PATH_LINK_DENIED")
    output.mkdir(parents=True, exist_ok=True)
    envelope = synthetic_packet()
    prompt = DshStdioAdapter._build_prompt(envelope)
    encoded = prompt.encode("utf-8")
    assert len(encoded) <= 8192
    packet = {
        "authorization_status": "NOT_APPROVED_FOR_MODEL_SEND",
        "runtime_version": EXPECTED_DSH_VERSION, "wire_server_version": "0.0.1",
        "provider": "deepseek-official", "model": "deepseek-flash",
        "budget": {"max_prompt_dispatches": 1, "max_output_tokens": 128, "max_input_bytes": 8192,
                   "max_seconds": 60, "automatic_retries": 0, "monetary_hard_limit_enforced": False},
        "prompt_bytes": len(encoded), "prompt_sha256": hashlib.sha256(encoded).hexdigest(),
        "id_note": "Preview uses fixed synthetic UUIDs; a real local run will receive new task/run/manifest IDs and own workspace path.",
        "prompt": prompt,
    }
    if args.verify_existing_packet:
        packet_path = ROOT / "output" / "harness-stdio-offline-20261014" / "synthetic-integration-packet.json"
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        validate_existing_packet(packet)
    else:
        packet_path = output / "synthetic-integration-packet.json"
        packet_path.write_text(json.dumps(packet, ensure_ascii=False, indent=2), encoding="utf-8")
    directory = ROOT / "data" / f".test-collaboration-profile-dump-{uuid.uuid4()}"
    adapter = DshStdioAdapter(replace(CollaborationSettings(), dsh_home=directory / "home", workspace=directory / "workspace"))
    try:
        adapter._verify_runtime()
        adapter._prepare_home()
        node = shutil.which("node")
        if not node:
            raise RuntimeError("NODE_NOT_FOUND")
        env = {name: os.environ[name] for name in ("PATH", "SystemRoot", "TEMP", "TMP") if name in os.environ}
        env["DSH_HOME"] = str(adapter.settings.dsh_home)
        result = subprocess.run([node, str(adapter.settings.dsh_bin), "--profile", adapter.settings.profile_name, "--dump-config"],
                                cwd=adapter.settings.workspace, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise RuntimeError("PROFILE_DUMP_FAILED")
        enabled = []
        for entry in DISABLED_PROFILE_ENTRIES:
            segment = result.stdout.split(f"- id: {entry}\n", 1)[1].split("\n- id:", 1)[0]
            assert "disabled: true" in segment
            enabled.append({"id": entry, "disabled": True})
        (output / "profile-dump.yml").write_text(result.stdout, encoding="utf-8")
        llm_config = result.stdout.split("- id: llm-deepseek\n", 1)[1].split("\n- id:", 1)[0]
        assert "baseURL: https://api.deepseek.com/anthropic" in llm_config
        assert "thinking: disabled" in llm_config
        assert any(f"reasoningEffort: {value}" in llm_config for value in ("off", "'off'", '"off"'))
        report = {"status": "PASS", "mode": "offline_config_dump_only", "runtime_version": EXPECTED_DSH_VERSION,
                  "disabled_entries": enabled, "prompt_bytes": len(encoded), "model_requests_sent": 0,
                  "packet_path": str(packet_path), "prompt_sha256": packet["prompt_sha256"],
                  "destination": "https://api.deepseek.com/anthropic", "reasoning": "disabled"}
        if args.verify_existing_packet:
            credential_present = bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())
            report.update({"status": "PREFLIGHT_ONLY" if credential_present else "BLOCKED_CREDENTIAL",
                           "profile_verification": "PASS", "credential_present": credential_present,
                           "blocker": None if credential_present else "DSH_CREDENTIAL_NOT_CONFIGURED",
                           "budget": packet["budget"], "packet_modified": False,
                           "real_call_attempted": False, "automatic_retries_performed": 0})
        (output / "preflight.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
    finally:
        if directory.exists() and directory.resolve().parent == (ROOT / "data").resolve() and directory.name.startswith(".test-collaboration-profile-dump-"):
            shutil.rmtree(directory)


if __name__ == "__main__":
    main()
