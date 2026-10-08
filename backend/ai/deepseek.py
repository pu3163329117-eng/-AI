"""Bounded DeepSeek JSON-mode adapter. No SDK, tools, redirects or hidden reasoning.

Official wire contract: https://api-docs.deepseek.com/api/create-chat-completion/
JSON mode does not guarantee our schema; FeedbackService remains the validator.
"""
from collections import deque
import json
import re
from time import monotonic

import httpx2 as httpx

from .contracts import OUTPUTS
from .providers import ProviderError
from .service import parse_json
from .settings import AISettings

ENDPOINT = "https://api.deepseek.com/chat/completions"
MAX_BYTES = 32_000
SENSITIVE_PATTERN = re.compile(r"\b1[3-9]\d{9}\b|(?<!\d)\d{17}[0-9Xx](?!\d)|"
                               r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|"
                               r"(?:sk-|ghp_)[A-Za-z0-9]{20,}")


class DeepSeekProvider:
    name = "deepseek"
    external = True

    def __init__(self, settings: AISettings, *, transport=None, clock=monotonic):
        self.settings = settings
        self.transport = transport
        self.clock = clock
        self.started_calls = deque()

    def reserve(self):
        now = self.clock()
        while self.started_calls and now - self.started_calls[0] >= 3600:
            self.started_calls.popleft()
        if len(self.started_calls) >= 20 or sum(now - at < 60 for at in self.started_calls) >= 5:
            raise ProviderError("RATE_LIMITED")
        self.started_calls.append(now)

    async def generate_structured(self, request):
        if not self.settings.ready:
            raise ProviderError("PROVIDER_UNAVAILABLE")
        if request.task not in OUTPUTS:
            raise ProviderError("INVALID_OUTPUT")
        if SENSITIVE_PATTERN.search(request.data_json):
            raise ProviderError("SAFETY_BLOCKED")
        # Only the server-owned task schema is used, never an arbitrary caller schema.
        schema = OUTPUTS[request.task].model_json_schema()
        payload = {"model": self.settings.model, "thinking": {"type": "disabled"},
                   "stream": False, "temperature": .2, "max_tokens": 768,
                   "response_format": {"type": "json_object"},
                   "messages": [{"role": "system", "content": request.system +
                       "\nReturn JSON matching this schema:\n" + json.dumps(schema, ensure_ascii=False)},
                       {"role": "user", "content": request.data_json}]}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(body) > MAX_BYTES:
            raise ProviderError("INVALID_OUTPUT")
        self.reserve()
        try:
            # Client lifetime is bounded to a call; service-level deadline includes
            # construction, network and body reading. No environment proxy/key relay.
            async with httpx.AsyncClient(transport=self.transport, timeout=4.0, trust_env=False,
                                        follow_redirects=False, verify=True,
                                        limits=httpx.Limits(max_connections=1)) as client:
                async with client.stream("POST", ENDPOINT, content=body,
                    headers={"Authorization": "Bearer " + self.settings.api_key,
                             "Content-Type": "application/json", "Accept": "application/json",
                             "Accept-Encoding": "identity"}) as response:
                    if response.status_code == 429:
                        raise ProviderError("RATE_LIMITED")
                    if response.status_code != 200:
                        # Do not read/echo vendor error bodies: these may contain keys.
                        raise ProviderError("PROVIDER_UNAVAILABLE")
                    if response.headers.get("content-encoding", "identity") != "identity":
                        raise ProviderError("INVALID_OUTPUT")
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(data) + len(chunk) > MAX_BYTES:
                            raise ProviderError("INVALID_OUTPUT")
                        data.extend(chunk)
                    envelope = parse_json(data.decode("utf-8"))
            choices = envelope.get("choices") if isinstance(envelope, dict) else None
            if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                raise ProviderError("INVALID_OUTPUT")
            choice = choices[0]
            if choice.get("finish_reason") == "content_filter":
                raise ProviderError("SAFETY_BLOCKED")
            if choice.get("finish_reason") != "stop":
                raise ProviderError("INVALID_OUTPUT")
            message = choice.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant" or message.get("tool_calls"):
                raise ProviderError("INVALID_OUTPUT")
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                raise ProviderError("INVALID_OUTPUT")
            # reasoning_content, usage metadata and other fields are never returned.
            return content
        except httpx.TimeoutException:
            raise ProviderError("PROVIDER_TIMEOUT") from None
        except httpx.DecodingError:
            raise ProviderError("INVALID_OUTPUT") from None
        except httpx.HTTPError:
            raise ProviderError("PROVIDER_UNAVAILABLE") from None
        except (UnicodeError, ValueError, TypeError, RecursionError):
            raise ProviderError("INVALID_OUTPUT") from None
