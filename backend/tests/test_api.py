from __future__ import annotations

import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402


def test_training_happy_path_and_idempotency():
    with TestClient(app) as client:
        created = client.post("/api/v1/training/sessions", json={})
        assert created.status_code == 201
        session_id = created.json()["session_id"]
        start_version = created.json()["session"]["state_version"]

        evidence = {"type": "SELECT_EVIDENCE", "expected_state_version": start_version, "payload": {}}
        first = client.post(f"/api/v1/training/sessions/{session_id}/commands", json=evidence, headers={"Idempotency-Key": "evidence-1"})
        assert first.status_code == 200
        replay = client.post(f"/api/v1/training/sessions/{session_id}/commands", json=evidence, headers={"Idempotency-Key": "evidence-1"})
        assert replay.status_code == 200 and replay.json() == first.json()

        answer = {"type": "SUBMIT_ATTEMPT", "expected_state_version": 2, "payload": {"answer": "跟从求教"}}
        validated = client.post(f"/api/v1/training/sessions/{session_id}/commands", json=answer, headers={"Idempotency-Key": "answer-1"})
        assert validated.status_code == 200
        assert validated.json()["state"] == "ANSWER_VALIDATED"


def test_version_conflict():
    with TestClient(app) as client:
        session_id = client.post("/api/v1/training/sessions", json={}).json()["session_id"]
        result = client.post(
            f"/api/v1/training/sessions/{session_id}/commands",
            json={"type": "REQUEST_HINT", "expected_state_version": 99, "payload": {}},
            headers={"Idempotency-Key": "conflict-1"},
        )
        assert result.status_code == 409
        assert result.json()["error"]["code"] == "VERSION_CONFLICT"


def test_transfer_challenge_and_dual_track_summary():
    with TestClient(app) as client:
        session_id = client.post("/api/v1/training/sessions", json={}).json()["session_id"]

        def send(version: int, command_type: str, payload: dict, key: str):
            return client.post(
                f"/api/v1/training/sessions/{session_id}/commands",
                json={"type": command_type, "expected_state_version": version, "payload": payload},
                headers={"Idempotency-Key": key},
            )

        assert send(1, "SELECT_EVIDENCE", {}, "core-evidence").status_code == 200
        assert send(2, "SUBMIT_ATTEMPT", {"answer": "跟从求教"}, "core-answer").json()["session"]["transfer_ready"] is True

        transfer = send(3, "CONTINUE_TO_TRANSFER", {}, "transfer-start")
        assert transfer.status_code == 200
        assert transfer.json()["session"]["stage"] == "TRANSFER"
        assert transfer.json()["session"]["source"] == "《论语·述而》"

        assert send(4, "SELECT_EVIDENCE", {}, "transfer-evidence").status_code == 200
        validated = send(5, "SUBMIT_ATTEMPT", {"answer": "跟随、学习"}, "transfer-answer")
        assert validated.status_code == 200
        assert validated.json()["state"] == "TRANSFER_VALIDATED"
        assert validated.json()["session"]["summary_ready"] is True

        completed = send(6, "COMPLETE_SESSION", {}, "complete")
        assert completed.status_code == 200
        assert completed.json()["session"]["completed"] is True
        assert completed.json()["session"]["summary"]["earned_points"] == 20
