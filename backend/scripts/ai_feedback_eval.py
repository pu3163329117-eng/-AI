"""Run offline fixtures only: python -m backend.scripts.ai_feedback_eval."""
import asyncio
import json

from backend.ai.evals import run_suite


def main():
    result = asyncio.run(run_suite())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] == result["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
