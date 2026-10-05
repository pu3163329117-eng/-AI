from __future__ import annotations

import copy
import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from backend.db.models import LessonContent  # noqa: E402
from backend.db.session import SessionLocal  # noqa: E402
from backend.main import app  # noqa: E402


def _create_profile(client: TestClient, school_stage: str = "JUNIOR") -> str:
    response = client.post(
        "/api/v1/profiles",
        json={"display_name": f"{school_stage} QA", "school_stage": school_stage},
    )
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def _command(client: TestClient, session_id: str, state_version: int, command_type: str, payload: dict, key: str) -> dict:
    response = client.post(
        f"/api/v1/training/sessions/{session_id}/commands",
        json={"type": command_type, "expected_state_version": state_version, "payload": payload},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 200, response.json()
    return response.json()


def test_junior_catalogue_to_completion_creates_reviewable_learning_record():
    """Exercise the learner-facing MVP path instead of isolated API responses."""
    with TestClient(app) as client:
        profile_id = _create_profile(client)
        catalogue = client.get("/api/v1/lessons", params={"school_stage": "JUNIOR"})
        assert catalogue.status_code == 200
        lesson = catalogue.json()["lessons"][0]
        assert lesson["id"] == "lesson-junior-cong-01"
        # Editorial users may publish additional junior lessons; the canonical seed must
        # remain present and first at its configured level order.
        assert any(item["id"] == "lesson-junior-cong-01" for item in catalogue.json()["lessons"])

        senior_catalogue = client.get("/api/v1/lessons", params={"school_stage": "SENIOR"})
        assert senior_catalogue.status_code == 200
        assert senior_catalogue.json()["lessons"][0]["id"] == "lesson-senior-gui-01"
        assert any(item["id"] == "lesson-senior-gui-01" for item in senior_catalogue.json()["lessons"])

        created = client.post(
            "/api/v1/training/sessions",
            json={"profile_id": profile_id, "lesson_id": lesson["id"]},
        )
        assert created.status_code == 201
        session_id = created.json()["session_id"]
        snapshot = created.json()["session"]
        assert snapshot["lesson"]["id"] == lesson["id"]
        assert snapshot["state"] == "AWAITING_INITIAL_ATTEMPT"

        # A learner can make an initial attempt, ask for scaffolding, then ground the answer in evidence.
        first_attempt = _command(client, session_id, 1, "SUBMIT_ATTEMPT", {"answer": "跟从求教"}, "loop-attempt")
        assert first_attempt["state"] == "AWAITING_REASONING"
        assert "选一句证据" in first_attempt["session"]["feedback"]

        hint = _command(client, session_id, 2, "REQUEST_HINT", {}, "loop-hint")
        assert hint["state"] == "HINT_PRESENTED"
        assert hint["session"]["hint_level"] == 1
        assert hint["session"]["hint"]

        evidence = _command(client, session_id, 3, "SELECT_EVIDENCE", {}, "loop-evidence")
        assert evidence["session"]["evidence_selected"] is True
        assert "证据" in evidence["session"]["feedback"]

        validated = _command(client, session_id, 4, "SUBMIT_ATTEMPT", {"answer": "跟从求教"}, "loop-validated")
        assert validated["state"] == "ANSWER_VALIDATED"
        assert validated["session"]["transfer_ready"] is True

        transfer = _command(client, session_id, 5, "CONTINUE_TO_TRANSFER", {}, "loop-transfer")
        assert transfer["session"]["stage"] == "TRANSFER"
        assert transfer["session"]["variable"] == "从"

        transfer_evidence = _command(client, session_id, 6, "SELECT_EVIDENCE", {}, "loop-transfer-evidence")
        transfer_validated = _command(
            client,
            session_id,
            transfer_evidence["state_version"],
            "SUBMIT_ATTEMPT",
            {"answer": "跟随、学习"},
            "loop-transfer-answer",
        )
        assert transfer_validated["state"] == "TRANSFER_VALIDATED"
        assert transfer_validated["session"]["summary_ready"] is True

        completed = _command(
            client,
            session_id,
            transfer_validated["state_version"],
            "COMPLETE_SESSION",
            {},
            "loop-complete",
        )
        assert completed["session"]["completed"] is True
        assert completed["session"]["summary"]["earned_points"] == 20
        assert completed["profile"]["total_points"] == 20
        assert completed["profile"]["completed_levels"] == 1

        review = client.get(f"/api/v1/profiles/{profile_id}/sessions")
        assert review.status_code == 200
        assert review.json()["sessions"][0]["updated_at"] is not None
        assert review.json()["sessions"] == [
            {
                "session_id": session_id,
                "source": "《论语·述而》",
                "stage": "TRANSFER",
                "completed": True,
                "feedback": "本关完成。你已经把一次语境判断迁移到了新的句子中。",
                "updated_at": review.json()["sessions"][0]["updated_at"],
            }
        ]

        # Progression must not return the completed seed. A content editor may have
        # published another junior lesson earlier in the suite, in which case it is
        # the valid next lesson instead of a null response.
        next_lesson = client.get("/api/v1/lessons/next", params={"school_stage": "JUNIOR", "profile_id": profile_id})
        assert next_lesson.status_code == 200
        next_payload = next_lesson.json()["lesson"]
        assert next_payload is None or next_payload["id"] != lesson["id"]


def test_started_session_keeps_a_content_snapshot_when_editorial_content_changes():
    """Editing a lesson must affect later sessions only, never a learner already in progress."""
    with TestClient(app) as client:
        profile_id = _create_profile(client)
        created = client.post(
            "/api/v1/training/sessions",
            json={"profile_id": profile_id, "lesson_id": "lesson-junior-cong-01"},
        )
        assert created.status_code == 201
        session_id = created.json()["session_id"]
        original_passage = created.json()["session"]["passage"]
        original_answer = created.json()["session"]["correct_answer"]

        with SessionLocal() as db:
            content = db.scalar(
                select(LessonContent).where(
                    LessonContent.lesson_id == "lesson-junior-cong-01",
                    LessonContent.stage == "CORE",
                )
            )
            assert content is not None
            original_payload = copy.deepcopy(content.payload)
            edited_payload = copy.deepcopy(content.payload)
            edited_payload.update(passage="编辑中的新题文", correct_answer="来自")
            content.payload = edited_payload
            db.commit()

        try:
            existing_session = client.get(f"/api/v1/training/sessions/{session_id}")
            assert existing_session.status_code == 200
            assert existing_session.json()["session"]["passage"] == original_passage
            assert existing_session.json()["session"]["correct_answer"] == original_answer

            later_session = client.post(
                "/api/v1/training/sessions",
                json={"profile_id": profile_id, "lesson_id": "lesson-junior-cong-01"},
            )
            assert later_session.status_code == 201
            assert later_session.json()["session"]["passage"] == "编辑中的新题文"
            assert later_session.json()["session"]["correct_answer"] == "来自"
        finally:
            with SessionLocal() as db:
                content = db.scalar(
                    select(LessonContent).where(
                        LessonContent.lesson_id == "lesson-junior-cong-01",
                        LessonContent.stage == "CORE",
                    )
                )
                assert content is not None
                content.payload = original_payload
                db.commit()
