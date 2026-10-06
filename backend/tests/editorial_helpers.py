"""Test-only editorial fixtures; source URLs are metadata, never live requests."""
from copy import deepcopy

import pytest
from sqlalchemy import delete, select

from backend.db.models import CommandReceipt, LearnerProfile, Lesson, LessonContent, LessonReview, TrainingEvent, TrainingSession
from backend.db.session import SessionLocal


def verified_content(content: dict) -> dict:
    result = deepcopy(content)
    for stage, payload in result.items():
        supplied = payload.get("reading_context", {})
        payload["reading_context"] = {
            "paragraphs": [payload["passage"]], "extent": "EXCERPT", "author": "测试作者",
            "era": "测试时代", "work_note": "原创测试材料，不用于实际教学。",
            "terms": [], **supplied,
            "source_url": supplied.get("source_url", "https://example.org/editorial-test-source"),
            "text_version": supplied.get("text_version", "test-v1"),
        }
    return result


def approve(client, lesson_id: str) -> dict:
    response = review(client, lesson_id, {
        "reviewer": "测试教研", "note": "测试材料核对完成。",
    })
    assert response.status_code == 200, response.json()
    assert response.json()["lesson"]["review"]["status"] == "APPROVED"
    return response.json()["lesson"]


def current_version(client, lesson_id: str) -> str:
    response = client.get(f"/api/v1/admin/lessons/{lesson_id}")
    assert response.status_code == 200
    return response.json()["lesson"]["review"]["content_version"]


def review(client, lesson_id: str, fields: dict):
    return client.post(f"/api/v1/admin/lessons/{lesson_id}/review", json={
        "expected_content_version": current_version(client, lesson_id), **fields,
    })


def publish(client, lesson_id: str):
    return client.post(f"/api/v1/admin/lessons/{lesson_id}/publish", json={
        "expected_content_version": current_version(client, lesson_id),
    })


@pytest.fixture
def cleanup_editorial_records():
    # Track only newly-created records; never delete profiles/lessons that existed
    # before this test, even when a prior test run left similarly named fixtures.
    with SessionLocal() as db:
        before_lessons = set(db.scalars(select(Lesson.id)))
        before_profiles = set(db.scalars(select(LearnerProfile.id)))
    yield
    with SessionLocal() as db:
        lesson_ids = [lesson.id for lesson in db.scalars(select(Lesson))
                      if lesson.id not in before_lessons and lesson.slug.startswith((
                          "admin-draft-", "admin-freeze-", "draft-", "context-freeze-", "reading-data-", "review-qa-"))]
        profile_ids = [profile.id for profile in db.scalars(select(LearnerProfile))
                       if profile.id not in before_profiles and profile.display_name.startswith(("编辑测试", "语境验收", "审核验收"))]
        session_ids = list(db.scalars(select(TrainingSession.id).where(
            TrainingSession.lesson_id.in_(lesson_ids) | TrainingSession.profile_id.in_(profile_ids))))
        if session_ids:
            db.execute(delete(CommandReceipt).where(CommandReceipt.session_id.in_(session_ids)))
            db.execute(delete(TrainingEvent).where(TrainingEvent.session_id.in_(session_ids)))
            db.execute(delete(TrainingSession).where(TrainingSession.id.in_(session_ids)))
        if lesson_ids:
            db.execute(delete(LessonReview).where(LessonReview.lesson_id.in_(lesson_ids)))
            db.execute(delete(LessonContent).where(LessonContent.lesson_id.in_(lesson_ids)))
            db.execute(delete(Lesson).where(Lesson.id.in_(lesson_ids)))
        if profile_ids:
            db.execute(delete(LearnerProfile).where(LearnerProfile.id.in_(profile_ids)))
        db.commit()
