"""The stress runner must stay entirely synthetic and reproducible."""
import asyncio
import json

import pytest

from backend.scripts.ai_offline_qualification import main, run_suite, variants


def test_qualification_cannot_access_a_real_model_or_configuration(monkeypatch):
    import backend.ai.deepseek as deepseek
    import backend.ai.settings as settings
    def forbidden(*args, **kwargs):
        pytest.fail("offline qualification must not access model or credentials")
    monkeypatch.setattr(deepseek.DeepSeekProvider, "generate_structured", forbidden)
    monkeypatch.setattr(deepseek.httpx, "AsyncClient", forbidden)
    monkeypatch.setattr(settings, "load_settings", forbidden)
    report = asyncio.run(run_suite(1))
    assert report["status"] == "PASS" and report["total"] == report["passed"] == 1458
    assert report["sections"]["boundary_matrix"]["total"] == 1218
    assert report["sections"]["runtime"]["passed"] == 159
    assert report["sections"]["recorded_batches"]["passed"] == 81
    assert not report["external_call_attempted"] and not report["semantic_accuracy_verified"]
    assert not report["may_update_learning"] and not report["live_ai_release_gate_satisfied"]
    serialized = json.dumps(report)
    assert "PRIVATE-VENDOR-ERROR" not in serialized and "student_reason" not in serialized


def test_variant_inventory_is_explicit_and_bounded():
    cases = variants()
    assert len(cases) == 32 and len({c[0] for c in cases}) == 32
    assert all(1 <= c[3] <= 2 for c in cases)


@pytest.mark.parametrize("rounds", [0, 11, True, 1.5, "3", None])
def test_bad_rounds_rejected_before_any_run(rounds):
    with pytest.raises(ValueError, match="^OFFLINE_QUALIFICATION_POLICY_INVALID$"):
        asyncio.run(run_suite(rounds))


def test_cli_exit_codes_are_not_always_success(monkeypatch, capsys):
    import backend.scripts.ai_offline_qualification as module
    async def failed(_):
        return {"status": "FAIL", "total": 1, "passed": 0}
    monkeypatch.setattr(module, "run_suite", failed)
    assert main(["--rounds", "1"]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "FAIL"
    with pytest.raises(SystemExit):
        main(["--rounds", "11"])
    with pytest.raises(SystemExit):
        main(["--live"])
