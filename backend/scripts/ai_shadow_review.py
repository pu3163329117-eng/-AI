"""No API server mutation. Live mode must be explicitly requested by the operator."""
import argparse
import asyncio
import json
from pathlib import Path

from backend.ai.evals import EVALUATOR
from backend.ai.settings import load_settings
from backend.ai.shadow import shadow_review


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Explicitly allow one paid shadow evaluation (at most one repair)")
    parser.add_argument("--case", type=Path, help="Local JSON case; never uploads a database or profile")
    args = parser.parse_args()
    case = {"task": "evaluator", "data_kind": "synthetic", "payload": EVALUATOR, "answer_aliases": []}
    try:
        if args.case:
            if args.case.stat().st_size > 32_000:
                raise ValueError("AI_CASE_INVALID")
            case = json.loads(args.case.read_text(encoding="utf-8-sig"))
        result = asyncio.run(shadow_review(load_settings(), case, live=args.live))
    except (OSError, ValueError, UnicodeError):
        # Raw input/config validation failures may contain private text: do not echo.
        print(json.dumps({"status": "NOT_RUN", "error_code": "AI_CASE_OR_CONFIGURATION_INVALID"}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "OK" else 1


if __name__ == "__main__":
    raise SystemExit(main())
