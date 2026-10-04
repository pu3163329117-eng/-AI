from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any


class Store:
    def __init__(self, database_path: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state_version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS commands (idempotency_key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(session_id, sequence_no));
        """)
        self.connection.commit()

    def create_session(self, snapshot: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        session_id = str(uuid.uuid4())
        self.connection.execute("INSERT INTO sessions(id, state_version, snapshot) VALUES (?, ?, ?)", (session_id, snapshot["state_version"], json.dumps(snapshot, ensure_ascii=False)))
        self.connection.commit()
        return session_id, snapshot

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT snapshot FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return json.loads(row["snapshot"]) if row else None

    def update_session(self, session_id: str, expected_version: int, snapshot: dict[str, Any], events: list[dict[str, Any]]) -> bool:
        with self.connection:
            result = self.connection.execute("UPDATE sessions SET state_version = ?, snapshot = ? WHERE id = ? AND state_version = ?", (snapshot["state_version"], json.dumps(snapshot, ensure_ascii=False), session_id, expected_version))
            if result.rowcount != 1:
                return False
            for index, event in enumerate(events, start=1):
                self.connection.execute("INSERT INTO events(id, session_id, sequence_no, type, payload) VALUES (?, ?, ?, ?, ?)", (str(uuid.uuid4()), session_id, expected_version + index, event["type"], json.dumps(event["payload"], ensure_ascii=False)))
        return True

    def cached_command(self, key: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT response FROM commands WHERE idempotency_key = ?", (key,)).fetchone()
        return json.loads(row["response"]) if row else None

    def cache_command(self, key: str, response: dict[str, Any]) -> None:
        with self.connection:
            self.connection.execute("INSERT OR REPLACE INTO commands(idempotency_key, response) VALUES (?, ?)", (key, json.dumps(response, ensure_ascii=False)))
