from __future__ import annotations

import json
import mimetypes
import os
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from domain.training import apply_command, initial_snapshot
from storage.sqlite_store import Store

ROOT = Path(__file__).parent
STORE = Store(ROOT / "data" / "wenyan-demo.db")
LOCK = threading.Lock()


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"status": "ok", "service": "wenyan-demo", "database": "sqlite"})
        if path.startswith("/api/v1/training/sessions/"):
            session = STORE.get_session(path.rsplit("/", 1)[-1])
            return self._json(200, {"session": session}) if session else self._json(404, {"error": {"code": "SESSION_NOT_FOUND"}})
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        size = int(self.headers.get("Content-Length", "0"))
        try:
            data = json.loads(self.rfile.read(size) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": {"code": "INVALID_JSON"}})
        if path == "/api/v1/training/sessions":
            session_id, snapshot = STORE.create_session(initial_snapshot())
            return self._json(201, {"session_id": session_id, "session": snapshot})
        if path.endswith("/commands") and "/api/v1/training/sessions/" in path:
            session_id = path.split("/sessions/")[1].split("/")[0]
            return self._command(session_id, data)
        return self._json(404, {"error": {"code": "NOT_FOUND"}})

    def _command(self, session_id: str, data: dict) -> None:
        key = self.headers.get("Idempotency-Key")
        if not key:
            return self._json(400, {"error": {"code": "IDEMPOTENCY_KEY_REQUIRED"}})
        cached = STORE.cached_command(key)
        if cached:
            return self._json(200, cached)
        with LOCK:
            snapshot = STORE.get_session(session_id)
            if not snapshot:
                return self._json(404, {"error": {"code": "SESSION_NOT_FOUND"}})
            if data.get("expected_state_version") != snapshot["state_version"]:
                return self._json(409, {"error": {"code": "VERSION_CONFLICT", "current_state_version": snapshot["state_version"]}})
            try:
                result = apply_command(snapshot, data)
            except ValueError as error:
                return self._json(409, {"error": {"code": str(error)}})
            if not STORE.update_session(session_id, snapshot["state_version"], result.snapshot, result.events):
                return self._json(409, {"error": {"code": "VERSION_CONFLICT"}})
            response = {"session_id": session_id, "state": result.state, "state_version": result.snapshot["state_version"], "session": result.snapshot}
            STORE.cache_command(key, response)
            return self._json(200, response)

    def log_message(self, fmt, *args):
        print("[http]", fmt % args)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"文言·推理 Demo: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), AppHandler).serve_forever()
