from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from backend.db.models import Lesson, LessonContent  # noqa: E402
from backend.db.session import SessionLocal  # noqa: E402
from backend.main import app  # noqa: E402


def _profile(client: TestClient, school_stage: str) -> str:
    response = client.post(
        "/api/v1/profiles",
        json={"display_name": f"专项训练 {school_stage} {uuid4().hex[:6]}", "school_stage": school_stage},
    )
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def _draft_payload(marker: str, group_label: str) -> dict:
    return {
        "slug": f"practice-plan-draft-{marker}",
        "school_stage": "JUNIOR",
        "title": "仅草稿：不应出现在专项训练",
        "source": "《测试篇》",
        "difficulty": "基础",
        "estimated_minutes": 6,
        "summary": "验证未发布内容不进入学习端。",
        "level_order": 15,
        "textbook_tags": [group_label],
        "theme": group_label,
        "accumulation_points": ["草稿积累点"],
        "reasoning_points": [group_label],
        "reasoning_level": "L1·语境取证",
    }


def _published_lesson(*, lesson_id: str, slug: str, level_order: int, group_label: str) -> Lesson:
    """A tiny public record with unique metadata makes ordering assertions isolated.

    Lesson contents are intentionally unnecessary here: the plans endpoint exposes
    catalogue metadata only, so this fixture tests its published/status filtering
    without coupling to the session-start contract.
    """
    return Lesson(
        id=lesson_id,
        slug=slug,
        title=f"专项排序课 {level_order}",
        school_stage="JUNIOR",
        level_order=level_order,
        source="《专项测试篇》",
        difficulty="基础",
        estimated_minutes=5,
        summary="用于验证专项训练分组排序。",
        status="PUBLISHED",
        textbook_tags=[group_label],
        theme=group_label,
        reasoning_level="L1·语境取证",
        accumulation_points=["测试积累点"],
        reasoning_points=[group_label],
    )


def _content(lesson_id: str, stage: str) -> LessonContent:
    suffix = "核心" if stage == "CORE" else "迁移"
    return LessonContent(
        lesson_id=lesson_id,
        stage=stage,
        payload={
            "source": "《专项测试篇》",
            "passage": f"{suffix}：甲从乙学。",
            "variable": "从",
            "question": "“从”是什么意思？",
            "choices": ["跟从学习", "离开"],
            "evidence": "从乙学",
            "correct_answer": "跟从学习",
            "hints": ["先看人物关系。"],
            "validated_feedback": "判断成立。",
        },
    )


def _remove_qa_lessons(*lesson_ids: str) -> None:
    """Remove only the uniquely named fixtures even if an assertion aborts early."""
    with SessionLocal() as db:
        db.execute(delete(LessonContent).where(LessonContent.lesson_id.in_(lesson_ids)))
        db.execute(delete(Lesson).where(Lesson.id.in_(lesson_ids)))
        db.commit()


def test_practice_plans_have_stable_profile_and_query_boundaries():
    with TestClient(app) as client:
        missing = client.get("/api/v1/profiles/missing/practice-plans")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "PROFILE_NOT_FOUND"

        profile_id = _profile(client, "JUNIOR")
        invalid = client.get(
            f"/api/v1/profiles/{profile_id}/practice-plans",
            params={"group_by": "not-a-real-group"},
        )
        assert invalid.status_code == 422
        assert invalid.json() == {"error": {"code": "INVALID_PRACTICE_GROUP"}}


def test_practice_plans_group_published_lessons_in_a_profile_stage_only():
    with TestClient(app) as client:
        junior_profile = _profile(client, "JUNIOR")
        senior_profile = _profile(client, "SENIOR")
        marker = uuid4().hex[:10]
        group_label = f"QA专项-{marker}"
        first_id = f"qa-practice-{marker}-first"
        second_id = f"qa-practice-{marker}-second"
        with SessionLocal() as db:
            # IDs sort opposite to level_order, proving the API uses curriculum
            # order rather than accidental lexical database order.
            db.add(_published_lesson(
                lesson_id=first_id,
                slug=f"qa-practice-{marker}-z",
                level_order=9001,
                group_label=group_label,
            ))
            db.add(_published_lesson(
                lesson_id=second_id,
                slug=f"qa-practice-{marker}-a",
                level_order=9002,
                group_label=group_label,
            ))
            db.add_all([
                _content(first_id, "CORE"), _content(first_id, "TRANSFER"),
                _content(second_id, "CORE"), _content(second_id, "TRANSFER"),
            ])
            db.commit()

        draft_id: str | None = None
        try:
            # The editorial endpoint creates a deliberate DRAFT.  Its unique metadata
            # must never be discoverable in a learner-facing plan.
            draft = client.post("/api/v1/admin/lessons", json=_draft_payload(marker, group_label))
            assert draft.status_code == 201
            draft_id = draft.json()["lesson"]["id"]

            junior = client.get(
                f"/api/v1/profiles/{junior_profile}/practice-plans",
                params={"group_by": "reasoning_point"},
            )
            assert junior.status_code == 200
            junior_payload = junior.json()
            assert junior_payload["group_by"] == "reasoning_point"
            assert [plan["label"] for plan in junior_payload["plans"]] == sorted(
                plan["label"] for plan in junior_payload["plans"]
            )
            junior_lessons = [lesson for plan in junior_payload["plans"] for lesson in plan["lessons"]]
            assert draft_id not in {lesson["id"] for lesson in junior_lessons}
            assert not any(lesson["id"].startswith("lesson-senior-") for lesson in junior_lessons)

            exact_plan = next(plan for plan in junior_payload["plans"] if plan["label"] == group_label)
            assert exact_plan["id"] == f"reasoning_point:{group_label}"
            assert exact_plan["lesson_count"] == 2
            assert [lesson["id"] for lesson in exact_plan["lessons"]] == [first_id, second_id]
            assert all(
                set(lesson) == {"id", "title", "source", "difficulty", "estimated_minutes", "summary"}
                for lesson in exact_plan["lessons"]
            )

            senior = client.get(
                f"/api/v1/profiles/{senior_profile}/practice-plans",
                params={"group_by": "reasoning_point"},
            )
            assert senior.status_code == 200
            plans = senior.json()["plans"]
            assert [plan["label"] for plan in plans] == sorted(plan["label"] for plan in plans)
            assert not any(
                lesson["id"].startswith("lesson-junior-")
                for plan in plans
                for lesson in plan["lessons"]
            )
            assert group_label not in {plan["label"] for plan in plans}
        finally:
            _remove_qa_lessons(first_id, second_id, *( [draft_id] if draft_id else [] ))
