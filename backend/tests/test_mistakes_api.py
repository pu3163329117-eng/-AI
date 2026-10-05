from __future__ import annotations

import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from backend.db.models import TrainingEvent, TrainingSession  # noqa: E402
from backend.db.session import SessionLocal  # noqa: E402
from backend.main import app  # noqa: E402


def _create_profile(client: TestClient, name: str) -> str:
    response = client.post("/api/v1/profiles", json={"display_name": name, "school_stage": "JUNIOR"})
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def _wrong_attempt(client: TestClient, profile_id: str, *, key_prefix: str, times: int = 1) -> str:
    created = client.post("/api/v1/training/sessions", json={"profile_id": profile_id, "lesson_id": "lesson-junior-cong-01"})
    assert created.status_code == 201
    session_id = created.json()["session_id"]
    version = created.json()["session"]["state_version"]
    for index in range(times):
        response = client.post(
            f"/api/v1/training/sessions/{session_id}/commands",
            json={"type": "SUBMIT_ATTEMPT", "expected_state_version": version, "payload": {"answer": "来自"}},
            headers={"Idempotency-Key": f"{key_prefix}-{index}"},
        )
        assert response.status_code == 200, response.json()
        version = response.json()["state_version"]
    return session_id


def test_mistake_bank_handles_missing_and_empty_profiles():
    with TestClient(app) as client:
        missing = client.get("/api/v1/profiles/missing/mistakes")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROFILE_NOT_FOUND"

        profile_id = _create_profile(client, "错题零状态")
        empty = client.get(f"/api/v1/profiles/{profile_id}/mistakes")
        assert empty.status_code == 200
        assert empty.json() == {"mistakes": []}


def test_mistake_bank_exposes_review_context_and_aggregates_repeated_wrong_attempts():
    with TestClient(app) as client:
        profile_id = _create_profile(client, "错题聚合")
        _wrong_attempt(client, profile_id, key_prefix="mistake-repeat", times=2)

        response = client.get(f"/api/v1/profiles/{profile_id}/mistakes")
        assert response.status_code == 200
        mistakes = response.json()["mistakes"]
        assert len(mistakes) == 1
        mistake = mistakes[0]
        assert set(mistake) == {
            "lesson_id", "title", "source", "variable", "passage", "wrong_attempts", "latest_attempt_at", "review_hint"
        }
        assert mistake["lesson_id"] == "lesson-junior-cong-01"
        assert mistake["title"] == "从：从人物关系推断词义"
        assert mistake["source"] == "《宋史·范仲淹传》"
        assert mistake["variable"] == "从"
        assert mistake["passage"] == "学者多从质问，为执经讲解，亡所倦。"
        assert mistake["wrong_attempts"] == 2
        assert isinstance(mistake["latest_attempt_at"], str) and mistake["latest_attempt_at"]
        assert mistake["review_hint"] == "回到证据“为执经讲解”，先判断人物和动作关系，再解释“从”在句中的意思。"


def test_mistake_bank_does_not_mix_profiles():
    with TestClient(app) as client:
        first_profile = _create_profile(client, "错题档案甲")
        second_profile = _create_profile(client, "错题档案乙")
        _wrong_attempt(client, first_profile, key_prefix="mistake-first")
        _wrong_attempt(client, second_profile, key_prefix="mistake-second", times=2)

        first = client.get(f"/api/v1/profiles/{first_profile}/mistakes")
        second = client.get(f"/api/v1/profiles/{second_profile}/mistakes")
        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["mistakes"][0]["wrong_attempts"] == 1
        assert second.json()["mistakes"][0]["wrong_attempts"] == 2
        assert first.json()["mistakes"][0]["latest_attempt_at"] != ""
        assert second.json()["mistakes"][0]["latest_attempt_at"] != ""


def test_mistake_bank_uses_frozen_snapshot_for_legacy_wrong_events():
    """Events created before context fields existed remain useful for review."""
    with TestClient(app) as client:
        profile_id = _create_profile(client, "旧记录错题")
        with SessionLocal() as db:
            record = TrainingSession(
                profile_id=profile_id,
                lesson_id="legacy-lesson-01",
                state_version=2,
                snapshot={
                    "lesson": {"id": "legacy-lesson-01", "title": "旧课：由语境推断词义"},
                    "source": "《旧文》",
                    "passage": "见其行而知其意。",
                    "variable": "见",
                    "evidence": "其行",
                },
            )
            db.add(record)
            db.flush()
            db.add(
                TrainingEvent(
                    session_id=record.id,
                    sequence_no=1,
                    type="training.attempt_evaluated",
                    payload={"label": "WRONG_CONTEXT"},
                )
            )
            db.commit()

        response = client.get(f"/api/v1/profiles/{profile_id}/mistakes")
        assert response.status_code == 200
        mistakes = response.json()["mistakes"]
        assert len(mistakes) == 1
        latest_attempt_at = mistakes[0].pop("latest_attempt_at")
        assert isinstance(latest_attempt_at, str) and latest_attempt_at
        assert mistakes == [
            {
                "lesson_id": "legacy-lesson-01",
                "title": "旧课：由语境推断词义",
                "source": "《旧文》",
                "variable": "见",
                "passage": "见其行而知其意。",
                "wrong_attempts": 1,
                "review_hint": "回到证据“其行”，先判断人物和动作关系，再解释“见”在句中的意思。",
            }
        ]
