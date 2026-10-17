"""Network-free subprocess peer implementing only the locally pinned SDK frames.

No Harness imports, credentials, model requests, Shell tools, or file access.
The parent selects a deterministic protocol fault with a fixture environment
variable. This script is never selectable by production runtime configuration.
"""
import json
import os
import sys
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
scenario = os.environ["DSH_FIXTURE_SCENARIO"]


def frame(value):
    print(json.dumps({"jsonrpc": "2.0", **value}, ensure_ascii=False), flush=True)


def notify(method, params):
    frame({"method": method, "params": params})


def events(session_id, message_id, text, *, turn=1, seq=0, reason="completed", interrupted=False):
    def event(kind, data, offset):
        return {"sessionId": session_id, "event": {"type": kind, "seq": seq + offset, "time": 0, "data": data}}
    return [
        ("session.status", {"sessionId": session_id, "status": "running"}),
        ("session.event", event("turn/start", {"turn": turn}, 0)),
        ("session.event", event("step/start", {"turn": turn, "step": 0}, 1)),
        ("session.event", event("user/message", {"id": message_id, "role": "user", "content": [{"type": "text", "text": "synthetic request"}]}, 2)),
        ("session.event", event("assistant/message", {
            "turn": turn, "step": 0, "message": {
                "id": "assistant-fixture", "role": "assistant", "content": [
                    {"type": "reasoning", "text": "HIDDEN_REASONING_SENTINEL"},
                    {"type": "text", "text": text},
                ],
            }, "stream": [{"secret": "HIDDEN_STREAM_SENTINEL"}], **({"interrupted": True} if interrupted else {}),
        }, 3)),
        ("session.event", event("turn/end", {"turn": turn, "reason": {"kind": reason}}, 4)),
        ("session.status", {"sessionId": session_id, "status": "idle"}),
    ]


def emit_all(items):
    for method, params in items:
        notify(method, params)


if scenario == "disconnect_before_init":
    sys.exit(0)

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "initialize":
        initialize_params = request["params"]
        if scenario == "initialize_error":
            frame({"id": request["id"], "error": {"code": -32603, "message": "private synthetic error"}})
        else:
            frame({"id": request["id"], "result": {"serverInfo": {
                "name": "wrong-runtime" if scenario == "bad_handshake" else "deepseek-harness-sdk-runtime",
                "version": "wrong-version" if scenario == "bad_version" else "0.0.1",
            }}})
            if scenario == "duplicate_initialize":
                frame({"id": request["id"], "result": {"serverInfo": {"name": "deepseek-harness-sdk-runtime", "version": "0.0.1"}}})
    elif request["method"] == "session/prompt":
        session_id = request["params"]["sessionId"]
        package = json.loads(request["params"]["contentBlocks"][0]["text"].split("\n", 1)[1])
        text = "合成 stdio 结果：完成关联成功。"
        if scenario == "inspect_initialize":
            text = json.dumps(initialize_params, ensure_ascii=False)
        if scenario == "inspect_history":
            text = json.dumps({"history": package["conversation_history"], "history_policy": package["history_policy"],
                               "request": package["request"], "task_id": package["task"]["task_id"],
                               "context_ids": [item["source_id"] for item in package["context_manifest"]["items"]]}, ensure_ascii=False)
        if scenario == "output_limit":
            text = "文" * 50_000
        items = events(session_id, "user-current", text)
        if scenario in {"turn_error", "turn_max_tokens", "turn_blocked", "turn_aborted"}:
            items = events(session_id, "user-current", text, reason={
                "turn_error": "error", "turn_max_tokens": "max-tokens", "turn_blocked": "blocked", "turn_aborted": "aborted",
            }[scenario])
        if scenario == "interrupted":
            items = events(session_id, "user-current", text, interrupted=True)
        if scenario == "notifications_before_receipt":
            emit_all(items)
            frame({"id": request["id"], "result": {"messageId": "user-current"}})
            continue
        if scenario == "prompt_error":
            frame({"id": request["id"], "error": {"code": -32603, "message": "synthetic enqueue failure"}})
            continue
        if scenario == "disconnect_after_prompt":
            sys.exit(0)
        if scenario == "invalid_receipt":
            frame({"id": request["id"], "result": {"messageId": 42}})
            continue
        frame({"id": request["id"], "result": {"messageId": "user-current"}})
        if scenario == "receipt_conflict":
            frame({"id": request["id"], "result": {"messageId": "user-other"}})
            continue
        if scenario == "disconnect_after_receipt":
            sys.exit(0)
        if scenario == "receipt_only":
            continue
        if scenario == "hang":
            emit_all(items[:1])
            continue
        if scenario == "wrong_session":
            emit_all(events("other-session", "user-current", "FOREIGN_SENTINEL"))
            continue
        if scenario == "wrong_message":
            emit_all(events(session_id, "user-other", "WRONG_USER_SENTINEL"))
            continue
        if scenario == "old_turn_then_current":
            emit_all(events(session_id, "user-old", "OLD_TURN_SENTINEL", turn=0))
            items = events(session_id, "user-current", text, turn=1, seq=10)
        if scenario == "foreign_child_noise":
            emit_all(events("child-session", "user-current", "CHILD_SENTINEL"))
            notify("subagent.finished", {"parentSessionId": "other-session", "childSessionId": "child-session",
                                        "lastAssistantMessage": [{"type": "text", "text": "CHILD_FINISH_SENTINEL"}]})
        if scenario == "child_started":
            notify("subagent.started", {"parentSessionId": session_id, "childSessionId": "child-session"})
            continue
        if scenario == "tool_call":
            notify("session.event", {"sessionId": session_id, "event": {"seq": 99, "type": "tool/call", "data": {"name": "pwsh", "arguments": "synthetic"}}})
            continue
        if scenario == "tool_header":
            notify("session.event", {"sessionId": session_id, "event": {"seq": 99, "type": "request/header", "data": {"header": {"tools": [{"name": "pwsh"}]}}}})
            continue
        if scenario == "tool_block":
            items[4][1]["event"]["data"]["message"]["content"].append({"type": "tool-call", "id": "bad-tool", "name": "pwsh", "arguments": "{}"})
        if scenario == "multiple_steps":
            emit_all(items[:4])
            notify("session.event", {"sessionId": session_id, "event": {"seq": 99, "type": "step/start", "data": {"turn": 1, "step": 1}}})
            continue
        if scenario == "retry":
            notify("session.event", {"sessionId": session_id, "event": {"seq": 99, "type": "llm/retry", "data": {}}})
            continue
        if scenario == "server_request":
            frame({"id": "server-approval", "method": "approve", "params": {}})
            continue
        if scenario == "oversize_frame":
            print("X" * 1_048_600, flush=True)
            continue
        if scenario == "stderr_secret":
            print("SYNTHETIC_SECRET_DO_NOT_PERSIST", file=sys.stderr, flush=True)
        if scenario == "malformed_lines":
            print("not-json", flush=True)
            print("null", flush=True)
            print("[]", flush=True)
        if scenario == "sequence_conflict":
            emit_all(items[:2])
            notify("session.event", {"sessionId": session_id, "event": {"type": "turn/start", "seq": 0, "time": 0, "data": {"turn": 99}}})
            continue
        if scenario == "idle_before_output":
            emit_all(items[:4] + items[5:])
            time.sleep(0.02)
            emit_all(items[4:5])
        elif scenario == "duplicate_events":
            for item in items:
                emit_all([item, item])
        elif scenario == "no_idle":
            emit_all(items[:-1])
        elif scenario == "no_turn_end":
            emit_all(items[:5] + items[6:])
        elif scenario == "missing_text":
            emit_all(events(session_id, "user-current", ""))
        else:
            emit_all(items)
    elif request["method"] == "shutdown":
        if scenario == "shutdown_hang":
            continue
        frame({"id": request["id"], "result": {}})
        break
