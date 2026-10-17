"""Pinned SDK notification correlation without exposing raw model reasoning.

The prompt receipt identifies a durable user message, not a completed turn.
Only that message's turn, successful turn/end, assistant text and root idle can
produce a result. Notifications may precede the enqueue response. All buffering
is bounded; unrelated sessions and child results never enter the candidate.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .errors import RuntimeFailure


SERVER_INFO = {"name": "deepseek-harness-sdk-runtime", "version": "0.0.1"}
MAX_EVENTS = 4096


def verify_handshake(result: Any) -> dict[str, str]:
    if not isinstance(result, dict) or result.get("serverInfo") != SERVER_INFO:
        raise RuntimeFailure("DSH_HANDSHAKE_IDENTITY_MISMATCH")
    return SERVER_INFO.copy()


class PromptTracker:
    def __init__(self, session_id: str, *, max_output_bytes: int):
        self.session_id = session_id
        self.max_output_bytes = max_output_bytes
        self.message_id: str | None = None
        self.running_seen = False
        self.status: str | None = None
        self.events: dict[int, dict[str, Any]] = {}
        self.fingerprints: dict[int, str] = {}
        self.buffer_bytes = 0
        self.max_buffer_bytes = max(1_048_576, max_output_bytes * 4)
        self.selected_turn: int | None = None
        self.selected_user_seq: int | None = None

    def receipt(self, result: Any) -> str:
        message_id = result.get("messageId") if isinstance(result, dict) else None
        if not isinstance(message_id, str) or not message_id or len(message_id) > 120:
            raise RuntimeFailure("DSH_ENQUEUE_RECEIPT_INVALID", outcome_unknown=True)
        self.message_id = message_id
        return message_id

    def notification(self, method: str, params: dict[str, Any]) -> None:
        if method in {"subagent.started", "subagent.finished"}:
            # This profile is tool-free. A new child indicates expanded runtime
            # capabilities rather than a valid root result.
            if params.get("parentSessionId") == self.session_id:
                raise RuntimeFailure("DSH_SUBAGENT_NOT_ALLOWED", outcome_unknown=True)
            return
        if params.get("sessionId") != self.session_id:
            return
        if method == "session.status":
            if params.get("status") not in {"running", "idle"}:
                raise RuntimeFailure("DSH_SESSION_STATUS_INVALID", outcome_unknown=True)
            self.status = params["status"]
            self.running_seen |= self.status == "running"
            return
        if method != "session.event":
            return
        event = params.get("event")
        if not isinstance(event, dict) or type(event.get("seq")) is not int or event["seq"] < 0:
            raise RuntimeFailure("DSH_SESSION_EVENT_INVALID", outcome_unknown=True)
        seq = event["seq"]
        raw = json.dumps(event, ensure_ascii=False, sort_keys=True).encode("utf-8")
        fingerprint = hashlib.sha256(raw).hexdigest()
        if seq in self.fingerprints:
            if self.fingerprints[seq] != fingerprint:
                raise RuntimeFailure("DSH_EVENT_SEQUENCE_CONFLICT", outcome_unknown=True)
            return
        self.buffer_bytes += len(raw)
        if len(self.fingerprints) >= MAX_EVENTS or self.buffer_bytes > self.max_buffer_bytes:
            raise RuntimeFailure("DSH_EVENT_BUFFER_LIMIT", outcome_unknown=True)
        self.fingerprints[seq] = fingerprint
        kind, data = event.get("type"), event.get("data")
        if not isinstance(kind, str) or not isinstance(data, dict):
            raise RuntimeFailure("DSH_SESSION_EVENT_INVALID", outcome_unknown=True)
        header = data.get("header") if isinstance(data.get("header"), dict) else {}
        if kind == "tool/call" or kind == "request/header" and header.get("tools"):
            raise RuntimeFailure("DSH_TOOL_NOT_ALLOWED", outcome_unknown=True)
        if kind in {"llm/retry", "llm/retry-started"}:
            raise RuntimeFailure("DSH_RETRY_NOT_ALLOWED", outcome_unknown=True)
        if kind == "assistant/message":
            message = data.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("content"), list):
                raise RuntimeFailure("DSH_ASSISTANT_MESSAGE_INVALID", outcome_unknown=True)
            # Keep only top-level text blocks. Raw streams and thinking/reasoning
            # blocks are hashed above and discarded, never persisted or returned.
            content = [item["text"] for item in message["content"]
                       if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)]
            if any(isinstance(item, dict) and item.get("type") in {"tool-call", "tool_use"} for item in message["content"]):
                raise RuntimeFailure("DSH_TOOL_NOT_ALLOWED", outcome_unknown=True)
            self.events[seq] = {"type": kind, "data": {
                "turn": data.get("turn"), "step": data.get("step"), "texts": content,
                "interrupted": data.get("interrupted", False),
            }}
        elif kind == "user/message":
            self.events[seq] = {"type": kind, "data": {"id": data.get("id"), "role": data.get("role")}}
        elif kind in {"turn/start", "turn/end", "step/start"}:
            # Do not retain error message text (it can include secrets).
            self.events[seq] = {"type": kind, "data": {
                "turn": data.get("turn"), "step": data.get("step"),
                "reason": {"kind": data.get("reason", {}).get("kind")} if isinstance(data.get("reason"), dict) else {},
            }}

    def result_text(self) -> str | None:
        if not self.message_id:
            return None
        users = [(seq, event) for seq, event in self.events.items()
                 if event["type"] == "user/message" and event["data"].get("id") == self.message_id]
        if not users:
            return None
        if len(users) != 1 or users[0][1]["data"].get("role") != "user":
            raise RuntimeFailure("DSH_USER_MESSAGE_CORRELATION_INVALID", outcome_unknown=True)
        user_seq = users[0][0]
        starts = [(seq, event) for seq, event in self.events.items() if event["type"] == "turn/start" and seq < user_seq]
        if not starts:
            return None
        start_seq, start = max(starts, key=lambda item: item[0])
        turn = start["data"].get("turn")
        if type(turn) is not int or turn < 0:
            raise RuntimeFailure("DSH_TURN_INVALID", outcome_unknown=True)
        self.selected_turn, self.selected_user_seq = turn, user_seq
        steps = [event for seq, event in self.events.items() if seq > start_seq
                 and event["type"] == "step/start" and event["data"].get("turn") == turn]
        if len(steps) > 1:
            raise RuntimeFailure("DSH_MODEL_CALL_LIMIT", outcome_unknown=True)
        ends = [(seq, event) for seq, event in self.events.items()
                if event["type"] == "turn/end" and event["data"].get("turn") == turn and seq > user_seq]
        if not ends:
            return None
        if len(ends) != 1:
            raise RuntimeFailure("DSH_TURN_END_CONFLICT", outcome_unknown=True)
        end_seq, end = ends[0]
        reason = end["data"]["reason"].get("kind")
        if reason != "completed":
            codes = {"error": "DSH_TURN_FAILED", "max-tokens": "DSH_OUTPUT_TOKEN_LIMIT",
                     "aborted": "DSH_TURN_ABORTED", "blocked": "DSH_TURN_BLOCKED"}
            raise RuntimeFailure(codes.get(reason, "DSH_TURN_END_UNSUPPORTED"), outcome_unknown=reason not in codes)
        assistants = [(seq, event) for seq, event in self.events.items()
                      if user_seq < seq < end_seq and event["type"] == "assistant/message" and event["data"].get("turn") == turn]
        if any(event["data"]["interrupted"] for _, event in assistants):
            raise RuntimeFailure("DSH_ASSISTANT_INTERRUPTED", outcome_unknown=True)
        text = "\n".join(part for _, event in sorted(assistants) for part in event["data"]["texts"]).strip()
        if len(text.encode("utf-8")) > self.max_output_bytes:
            raise RuntimeFailure("DSH_OUTPUT_BYTE_LIMIT", outcome_unknown=True)
        if not self.running_seen or self.status != "idle":
            return None
        # Missing text can still arrive after idle: keep waiting rather than
        # claim success or fail before the pending output event is delivered.
        return text or None
