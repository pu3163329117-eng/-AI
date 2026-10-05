from __future__ import annotations

import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402
from backend.main import app  # noqa: E402


def _profile(client: TestClient, school_stage: str) -> str:
    response = client.post("/api/v1/profiles", json={"display_name": f"{school_stage} learner", "school_stage": school_stage})
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def test_lesson_catalogue_contract_and_explicit_senior_session():
    with TestClient(app) as client:
        junior = client.get("/api/v1/lessons", params={"school_stage": "JUNIOR"})
        assert junior.status_code == 200
        assert set(junior.json()["lessons"][0]) == {"id", "title", "source", "difficulty", "estimated_minutes", "summary"}
        assert junior.json()["lessons"][0]["id"] == "lesson-junior-cong-01"

        senior = client.get("/api/v1/lessons", params={"school_stage": "SENIOR"})
        assert senior.status_code == 200
        senior_lesson = senior.json()["lessons"][0]
        assert senior_lesson["id"] == "lesson-senior-gui-01"

        profile_id = _profile(client, "SENIOR")
        created = client.post("/api/v1/training/sessions", json={"profile_id": profile_id, "lesson_id": senior_lesson["id"]})
        assert created.status_code == 201
        snapshot = created.json()["session"]
        assert snapshot["lesson"]["id"] == senior_lesson["id"]
        assert snapshot["variable"] == "归"
        assert snapshot["correct_answer"] == "归依、志同道合"


def test_next_lesson_selects_stage_and_rejects_cross_stage_request():
    with TestClient(app) as client:
        profile_id = _profile(client, "JUNIOR")
        next_lesson = client.get("/api/v1/lessons/next", params={"school_stage": "JUNIOR", "profile_id": profile_id})
        assert next_lesson.status_code == 200
        assert next_lesson.json()["lesson"]["id"] == "lesson-junior-cong-01"

        mismatch = client.post("/api/v1/training/sessions", json={"profile_id": profile_id, "lesson_id": "lesson-senior-gui-01"})
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "LESSON_STAGE_MISMATCH"
