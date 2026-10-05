from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from uuid import uuid4

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


def _profile(client: TestClient) -> str:
    response = client.post(
        "/api/v1/profiles",
        json={"display_name": f"每日任务 {uuid4().hex[:6]}", "school_stage": "JUNIOR"},
    )
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def _command(client: TestClient, session_id: str, version: int, type_: str, payload: dict, key: str) -> dict:
    response = client.post(
        f"/api/v1/training/sessions/{session_id}/commands",
        json={"type": type_, "expected_state_version": version, "payload": payload},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 200, response.json()
    return response.json()


def test_daily_mission_has_real_zero_state_and_missing_profile_boundary():
    with TestClient(app) as client:
        missing = client.get("/api/v1/profiles/missing/daily-mission")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROFILE_NOT_FOUND"

        profile_id = _profile(client)
        response = client.get(f"/api/v1/profiles/{profile_id}/daily-mission")

    assert response.status_code == 200
    mission = response.json()["mission"]
    assert mission == {
        "mission_date": date.today().isoformat(),
        "target_completed_sessions": 1,
        "completed_sessions_today": 0,
        "completed": False,
        "recommended_lesson": {
            "id": "lesson-junior-cong-01",
            "title": "从：从人物关系推断词义",
            "source": "《宋史·范仲淹传》",
            "difficulty": "基础",
            "estimated_minutes": 8,
            "summary": "用人物关系与行为证据理解“从”的词义。",
        },
    }


def test_daily_mission_marks_today_complete_from_completed_session_event():
    with TestClient(app) as client:
        profile_id = _profile(client)
        created = client.post(
            "/api/v1/training/sessions",
            json={"profile_id": profile_id, "lesson_id": "lesson-junior-cong-01"},
        )
        assert created.status_code == 201
        session_id = created.json()["session_id"]
        session = created.json()["session"]

        response = _command(client, session_id, 1, "SELECT_EVIDENCE", {}, "daily-core-evidence")
        response = _command(client, session_id, response["state_version"], "SUBMIT_ATTEMPT", {"answer": session["correct_answer"]}, "daily-core-answer")
        response = _command(client, session_id, response["state_version"], "CONTINUE_TO_TRANSFER", {}, "daily-transfer")
        response = _command(client, session_id, response["state_version"], "SELECT_EVIDENCE", {}, "daily-transfer-evidence")
        response = _command(client, session_id, response["state_version"], "SUBMIT_ATTEMPT", {"answer": response["session"]["correct_answer"]}, "daily-transfer-answer")
        _command(client, session_id, response["state_version"], "COMPLETE_SESSION", {}, "daily-complete")

        mission = client.get(f"/api/v1/profiles/{profile_id}/daily-mission").json()["mission"]

    assert mission["completed_sessions_today"] == 1
    assert mission["completed"] is True
    assert mission["recommended_lesson"]["id"] == "lesson-junior-qu-01"
