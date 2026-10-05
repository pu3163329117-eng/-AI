from __future__ import annotations

import os
from datetime import date
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


def _create_profile(client: TestClient) -> str:
    response = client.post("/api/v1/profiles", json={"display_name": "学习画像测试", "school_stage": "JUNIOR"})
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def _send(client: TestClient, session_id: str, version: int, command_type: str, payload: dict, key: str) -> dict:
    response = client.post(
        f"/api/v1/training/sessions/{session_id}/commands",
        json={"type": command_type, "expected_state_version": version, "payload": payload},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 200, response.json()
    return response.json()


def test_learning_summary_has_useful_zero_state_and_404():
    with TestClient(app) as client:
        missing = client.get("/api/v1/profiles/missing/learning-summary")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROFILE_NOT_FOUND"

        profile_id = _create_profile(client)
        response = client.get(f"/api/v1/profiles/{profile_id}/learning-summary")
        assert response.status_code == 200
        assert response.json() == {
            "summary": {
                "total_points": 0,
                "completed_lessons": 0,
                "completed_sessions": 0,
                "current_streak_days": 0,
                "weak_skills": [],
                "recent_activity": [],
            }
        }


def test_learning_summary_aggregates_completion_points_streak_and_accuracy():
    with TestClient(app) as client:
        profile_id = _create_profile(client)
        created = client.post("/api/v1/training/sessions", json={"profile_id": profile_id})
        assert created.status_code == 201
        session_id = created.json()["session_id"]

        # One incorrect first attempt, followed by two validated answers, gives 2/3 accuracy.
        _send(client, session_id, 1, "SUBMIT_ATTEMPT", {"answer": "来自"}, "summary-wrong")
        _send(client, session_id, 2, "SELECT_EVIDENCE", {}, "summary-core-evidence")
        _send(client, session_id, 3, "SUBMIT_ATTEMPT", {"answer": "跟从求教"}, "summary-core-answer")
        _send(client, session_id, 4, "CONTINUE_TO_TRANSFER", {}, "summary-transfer")
        _send(client, session_id, 5, "SELECT_EVIDENCE", {}, "summary-transfer-evidence")
        _send(client, session_id, 6, "SUBMIT_ATTEMPT", {"answer": "跟随、学习"}, "summary-transfer-answer")
        _send(client, session_id, 7, "COMPLETE_SESSION", {}, "summary-complete")

        response = client.get(f"/api/v1/profiles/{profile_id}/learning-summary")
        assert response.status_code == 200
        summary = response.json()["summary"]
        assert set(summary) == {
            "total_points", "completed_lessons", "completed_sessions", "current_streak_days", "weak_skills", "recent_activity"
        }
        assert summary["total_points"] == 20
        assert summary["completed_lessons"] == 1
        assert summary["completed_sessions"] == 1
        assert summary["current_streak_days"] == 1
        assert summary["weak_skills"] == [{"label": "词义判断·从", "attempts": 3, "accuracy": 0.667}]
        assert summary["recent_activity"] == [
            {"date": date.today().isoformat(), "points": 20, "completed_sessions": 1}
        ]
