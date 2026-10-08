"""Mock HTTP only. These tests never hit DeepSeek or write learner databases."""
import asyncio
from copy import deepcopy
import json

import httpx2 as httpx
import pytest

from backend.ai.contracts import OUTPUTS
from backend.ai.deepseek import DeepSeekProvider, ENDPOINT
from backend.ai.evals import EVALUATOR
from backend.ai.prompts import PROMPTS
from backend.ai.providers import ProviderError, StructuredRequest
from backend.ai.service import FeedbackService
from backend.ai.settings import AISettings, load_settings
from backend.ai.shadow import shadow_review

KEY = "fixture-key-not-a-real-credential"
SETTINGS = AISettings(True, "minimal_learning", "deepseek-flash", KEY)
OUTPUT = {"label": "UNSCORABLE", "score": None, "matched_rubric_items": [],
          "misconception_codes": [], "evidence_ids": [], "evidence_quality": None,
          "next_action_recommendation": "HUMAN_REVIEW", "confidence": None}
CASE = {"task": "evaluator", "data_kind": "synthetic", "payload": EVALUATOR, "answer_aliases": []}


def request():
    return StructuredRequest("evaluator", PROMPTS["evaluator"], json.dumps(EVALUATOR), OUTPUTS["evaluator"].model_json_schema())


def response(content=None, **choice_changes):
    choice = {"finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(OUTPUT) if content is None else content,
                                                  "reasoning_content": "private thoughts not to expose"}, **choice_changes}
    return httpx.Response(200, json={"choices": [choice]})


def test_valid_wire_contract_and_no_private_reasoning_or_identity_sent():
    observed = []
    def handler(req):
        observed.append(req)
        return response()
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(handler))
    result = asyncio.run(FeedbackService(provider, approved_external=("deepseek",)).run("evaluator", EVALUATOR))
    assert result.status == "OK" and not result.simulated and not result.may_update_learning
    assert "private thoughts" not in repr(result) and KEY not in repr(provider.settings)
    wire = observed[0]
    assert str(wire.url) == ENDPOINT and wire.headers["Authorization"] == "Bearer " + KEY
    body = json.loads(wire.content)
    assert body["model"] == "deepseek-flash" and body["max_tokens"] == 768
    assert body["thinking"] == {"type": "disabled"} and body["response_format"] == {"type": "json_object"}
    assert not body["stream"] and "tools" not in body and "user_id" not in body
    assert json.loads(body["messages"][1]["content"]) == EVALUATOR


@pytest.mark.parametrize("status,code", [(400, "PROVIDER_UNAVAILABLE"), (401, "PROVIDER_UNAVAILABLE"),
                                      (402, "PROVIDER_UNAVAILABLE"), (403, "PROVIDER_UNAVAILABLE"),
                                      (422, "PROVIDER_UNAVAILABLE"), (429, "RATE_LIMITED"),
                                      (500, "PROVIDER_UNAVAILABLE"), (503, "PROVIDER_UNAVAILABLE"),
                                      (302, "PROVIDER_UNAVAILABLE")])
def test_http_status_mapping_never_reflects_vendor_errors_or_follows_redirects(status, code):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(status, headers={"Location": "https://untrusted.example"}, text=KEY)
    result = asyncio.run(shadow_review(SETTINGS, CASE, live=True, transport=httpx.MockTransport(handler)))
    assert result["error_code"] == code and len(calls) == 1
    assert KEY not in repr(result) and not result["may_update_learning"]


@pytest.mark.parametrize("change,code", [({"finish_reason": "length"}, "INVALID_OUTPUT"),
                                       ({"finish_reason": "content_filter"}, "SAFETY_BLOCKED"),
                                       ({"finish_reason": "aborted"}, "INVALID_OUTPUT"),
                                       ({"message": {"role": "assistant", "content": ""}}, "INVALID_OUTPUT"),
                                       ({"message": {"role": "assistant", "content": "{}", "tool_calls": [{"name": "exec"}]}}, "INVALID_OUTPUT")])
def test_truncated_filtered_empty_or_tool_outputs_fail_closed(change, code):
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: response(**change)))
    with pytest.raises(ProviderError, match=code):
        asyncio.run(provider.generate_structured(request()))


@pytest.mark.parametrize("body", [{}, {"choices": []}, {"choices": [False]}, {"choices": [None, None]}])
def test_invalid_envelope(body):
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: httpx.Response(200, json=body)))
    with pytest.raises(ProviderError, match="INVALID_OUTPUT"):
        asyncio.run(provider.generate_structured(request()))


def test_body_and_input_caps_compression_and_nonutf8_fail_closed():
    for body, headers in [(b"x" * 32001, {}), (b"\xff", {}), (b"garbled", {"Content-Encoding": "gzip"})]:
        provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: httpx.Response(200, content=body, headers=headers)))
        with pytest.raises(ProviderError, match="INVALID_OUTPUT"):
            asyncio.run(provider.generate_structured(request()))
    called = []
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: called.append(req)))
    huge = StructuredRequest("evaluator", "x" * 32_001, "{}", {})
    with pytest.raises(ProviderError, match="INVALID_OUTPUT"):
        asyncio.run(provider.generate_structured(huge))
    assert called == []


@pytest.mark.parametrize("error,code", [(httpx.ConnectTimeout("secret " + KEY), "PROVIDER_TIMEOUT"),
                                      (httpx.ConnectError("secret " + KEY), "PROVIDER_UNAVAILABLE")])
def test_network_errors_are_sanitized(error, code):
    def handler(req):
        raise error
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderError, match=code) as caught:
        asyncio.run(provider.generate_structured(request()))
    assert KEY not in str(caught.value)


def test_rate_caps_include_repairs_and_expire_conservatively():
    now = [0]
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: response()), clock=lambda: now[0])
    for _ in range(5):
        asyncio.run(provider.generate_structured(request()))
    with pytest.raises(ProviderError, match="RATE_LIMITED"):
        asyncio.run(provider.generate_structured(request()))
    for minute in (1, 2, 3):
        now[0] = minute * 61
        for _ in range(5):
            asyncio.run(provider.generate_structured(request()))
    now[0] = 300
    with pytest.raises(ProviderError, match="RATE_LIMITED"):
        asyncio.run(provider.generate_structured(request()))
    now[0] = 3601
    asyncio.run(provider.generate_structured(request()))


def test_disabled_default_or_absent_explicit_live_switch_never_calls_transport():
    calls = []
    transport = httpx.MockTransport(lambda req: calls.append(req))
    for settings, live in [(SETTINGS, False), (AISettings(), True), (AISettings(False, api_key=KEY), True)]:
        result = asyncio.run(shadow_review(settings, CASE, live=live, transport=transport))
        assert result["status"] == "FALLBACK" and not result["external_call_attempted"]
    assert calls == []


def test_real_data_permission_and_closed_input_are_checked_before_send():
    calls = []
    transport = httpx.MockTransport(lambda req: calls.append(req))
    actual = {**CASE, "data_kind": "minimal_learning"}
    with pytest.raises(ValueError, match="AI_DATA_POLICY_REQUIRED"):
        asyncio.run(shadow_review(AISettings(True, api_key=KEY), actual, live=True, transport=transport))
    private = deepcopy(CASE)
    private["payload"]["nickname"] = "must-not-send"
    with pytest.raises(ValueError, match="AI_CASE_INVALID"):
        asyncio.run(shadow_review(SETTINGS, private, live=True, transport=transport))
    assert calls == []


def test_configuration_file_is_literal_whitelisted_and_secret_not_in_repr(tmp_path):
    path = tmp_path / ".env"
    path.write_text('DEEPSEEK_API_KEY="' + KEY + '"\nWENYAN_AI_ENABLED=1\nWENYAN_AI_DATA_POLICY=minimal_learning\nUNKNOWN=$(not-executed)', encoding="utf-8")
    settings = load_settings(environ={}, env_file=path)
    assert settings.ready and settings.api_key == KEY and KEY not in repr(settings)
    disabled = load_settings(environ={"WENYAN_AI_ENABLED": "0"}, env_file=path)
    assert not disabled.ready
    assert not load_settings(environ={}, env_file=tmp_path / "missing").ready


@pytest.mark.parametrize("line", ["WENYAN_AI_ENABLED=perhaps", "WENYAN_AI_DATA_POLICY=all_records", "WENYAN_AI_MODEL=unknown-model",
                                'DEEPSEEK_API_KEY="unterminated', "DEEPSEEK_API_KEY=a b", "DEEPSEEK_API_KEY=a\nDEEPSEEK_API_KEY=b"])
def test_bad_config_is_generic_and_never_echoes_values(tmp_path, line):
    path = tmp_path / ".env"
    path.write_text(line, encoding="utf-8")
    with pytest.raises(ValueError, match="^AI_CONFIGURATION_INVALID$"):
        load_settings(environ={}, env_file=path)


@pytest.mark.parametrize("text", ["13812345678", "someone@example.com", "110101199001010011"])
def test_known_personal_identifiers_blocked_before_transport(text):
    called = []
    provider = DeepSeekProvider(SETTINGS, transport=httpx.MockTransport(lambda req: called.append(req)))
    input_request = StructuredRequest("evaluator", PROMPTS["evaluator"], json.dumps({**EVALUATOR, "student_reason": text}), {})
    with pytest.raises(ProviderError, match="SAFETY_BLOCKED"):
        asyncio.run(provider.generate_structured(input_request))
    assert called == []


def test_readonly_rollout_status_can_distinguish_configuration_from_student_release(monkeypatch):
    from backend import ai_routes
    monkeypatch.setattr(ai_routes, "load_settings", lambda: SETTINGS)
    status = ai_routes.ai_status()
    assert status["key_configured"] and status["shadow_feedback_available"]
    assert not status["external_calls_enabled"] and not status["semantic_feedback_available"]
    assert not status["student_feedback_enabled"] and KEY not in repr(status)
    def invalid():
        raise ValueError("AI_CONFIGURATION_INVALID")
    monkeypatch.setattr(ai_routes, "load_settings", invalid)
    assert not ai_routes.ai_status()["configuration_valid"]
