"""Offline review helper. No --live option, key loading, network or DB writes."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

from backend.ai.calibration import compare_recorded, manifest, self_test


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline draft reasoning-feedback calibration")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--self-test", action="store_true", help="Scripted plumbing checks, not model accuracy")
    group.add_argument("--export-inputs", action="store_true", help="Print synthetic minimal inputs; no local expectations")
    group.add_argument("--responses", type=Path, help="Compare a version-bound recorded candidate file")
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            result = asyncio.run(self_test())
        elif args.responses:
            # Bound the actual read, not only a pre-read stat (the file could
            # change between those operations).
            with args.responses.open("rb") as source:
                raw = source.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError("Too large")
            result = compare_recorded(parse_json_batch(raw.decode("utf-8-sig")))
        elif args.export_inputs:
            result = manifest()
        else:
            inputs = manifest()
            result = {key: inputs[key] for key in ("suite_version", "suite_digest", "prompt_version", "schema_version", "review_status", "total", "may_update_learning", "live_ai_release_gate_satisfied")}
            result.update(status="NOT_RUN", external_call_attempted=False, semantic_accuracy_verified=False,
                          next_step="Review draft cases, then explicitly authorize a bounded live comparison separately.")
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        # Do not echo a file path, student text, raw response or validation error.
        print(json.dumps({"status": "NOT_RUN", "error_code": "CALIBRATION_RECORD_INVALID",
                          "external_call_attempted": False, "live_ai_release_gate_satisfied": False}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if ("passed" in result and result["passed"] != result["total"]) else 0


def parse_json_batch(raw):
    # The service parser has a per-response 32KB ceiling. A batch may contain
    # many such responses; reuse its duplicate-key/non-finite guards, not that
    # single-response size ceiling. Never accept Python's NaN/Infinity defaults.
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("Nonfinite number")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


if __name__ == "__main__":
    # Keep exported Chinese JSON UTF-8 even when Windows pipes would otherwise
    # choose the legacy console encoding. Library/test calls keep their streams.
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
