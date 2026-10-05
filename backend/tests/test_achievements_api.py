from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta
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


def _completed_snapshot(index: int) -> dict:
    return {
        "completed": True,
        "variable": "从",
        "lesson": {"id": f"achievement-lesson-{index}"},
        "summary": {"earned_points": 20},
    }


def test_achievements_zero_state_and_missing_profile():
    with TestClient(app) as client:
        missing = client.get("/api/v1/profiles/missing/achievements")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROFILE_NOT_FOUND"

        profile_id = _create_profile(client, "成就零状态")
        response = client.get(f"/api/v1/profiles/{profile_id}/achievements")
        assert response.status_code == 200
        assert response.json() == {
            "achievements": [
                {"id": "FIRST_COMPLETION", "label": "首次完成", "description": "完成 1 次完整的语境推理训练。", "unlocked": False, "current": 0, "target": 1},
                {"id": "EVIDENCE_KEEPER", "label": "证据守护者", "description": "在判断前累计选出 3 条文本证据。", "unlocked": False, "current": 0, "target": 3},
                {"id": "STEADY_READER", "label": "稳定阅读", "description": "连续 3 天完成学习训练。", "unlocked": False, "current": 0, "target": 3},
                {"id": "PERSISTENT_READER", "label": "坚持阅读", "description": "累计完成 5 次完整训练。", "unlocked": False, "current": 0, "target": 5},
            ],
            "review_recommendation": {
                "kind": "START",
                "title": "从第一关开始",
                "description": "完成一节语境推理训练，建立你的学习记录。",
                "action_label": "开始今日关卡",
            },
        }


def test_achievements_use_real_sessions_events_streak_and_review_priority():
    with TestClient(app) as client:
        profile_id = _create_profile(client, "成就记录")
        today = date.today()
        with SessionLocal() as db:
            for index in range(5):
                record = TrainingSession(profile_id=profile_id, lesson_id=None, state_version=8, snapshot=_completed_snapshot(index))
                db.add(record)
                db.flush()
                completed_on = today - timedelta(days=min(index, 2))
                completed_at = datetime.combine(completed_on, time(hour=12))
                if index < 3:
                    db.add(
                        TrainingEvent(
                            session_id=record.id,
                            sequence_no=1,
                            type="training.evidence_selected",
                            payload={"stage": "CORE"},
                            created_at=completed_at,
                        )
                    )
                db.add(
                    TrainingEvent(
                        session_id=record.id,
                        sequence_no=2 if index < 3 else 1,
                        type="training.session_completed",
                        payload={"points": 20},
                        created_at=completed_at,
                    )
                )
            db.commit()

        response = client.get(f"/api/v1/profiles/{profile_id}/achievements")
        assert response.status_code == 200
        payload = response.json()
        assert payload["achievements"] == [
            {"id": "FIRST_COMPLETION", "label": "首次完成", "description": "完成 1 次完整的语境推理训练。", "unlocked": True, "current": 5, "target": 1},
            {"id": "EVIDENCE_KEEPER", "label": "证据守护者", "description": "在判断前累计选出 3 条文本证据。", "unlocked": True, "current": 3, "target": 3},
            {"id": "STEADY_READER", "label": "稳定阅读", "description": "连续 3 天完成学习训练。", "unlocked": True, "current": 3, "target": 3},
            {"id": "PERSISTENT_READER", "label": "坚持阅读", "description": "累计完成 5 次完整训练。", "unlocked": True, "current": 5, "target": 5},
        ]
        assert payload["review_recommendation"]["kind"] == "NEXT_LESSON"

        # A weak skill always takes precedence over a generic next-lesson prompt.
        with SessionLocal() as db:
            weak_record = TrainingSession(
                profile_id=profile_id,
                lesson_id=None,
                state_version=2,
                snapshot={"completed": False, "variable": "从"},
            )
            db.add(weak_record)
            db.flush()
            db.add(
                TrainingEvent(
                    session_id=weak_record.id,
                    sequence_no=1,
                    type="training.attempt_evaluated",
                    payload={"label": "WRONG_CONTEXT"},
                )
            )
            db.commit()

        priority = client.get(f"/api/v1/profiles/{profile_id}/achievements")
        assert priority.status_code == 200
        recommendation = priority.json()["review_recommendation"]
        assert recommendation["kind"] == "WEAK_SKILL"
        assert recommendation["title"] == "复习：词义判断·从"
        assert recommendation["action_label"] == "开始复习"
