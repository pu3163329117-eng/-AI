"""Content provenance and review gates are exercised through the real API."""
from __future__ import annotations

import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from backend.main import app  # noqa: E402
import backend.main as main_module  # noqa: E402
from backend.db.models import LessonReview  # noqa: E402
from backend.db.session import SessionLocal  # noqa: E402
from backend.tests.editorial_helpers import approve, cleanup_editorial_records, current_version, publish, review, verified_content  # noqa: E402, F401

pytestmark = pytest.mark.usefixtures("cleanup_editorial_records")


def _payload() -> dict:
    content = {}
    for stage, passage in (("CORE", "甲从乙学。"), ("TRANSFER", "择其善者而从之。")):
        content[stage] = {
            "source": "《审核测试篇》", "passage": passage, "variable": "从",
            "question": "从是什么意思？", "choices": ["跟随学习", "归还"],
            "evidence": "乙" if stage == "CORE" else "善者", "correct_answer": "跟随学习",
            "hints": ["看人物与动作关系。"], "validated_feedback": "有证据支持判断。",
        }
    return {
        "slug": f"review-qa-{uuid4().hex[:12]}", "school_stage": "JUNIOR", "title": "审核闭环测试",
        "source": "《审核测试篇》", "difficulty": "基础", "estimated_minutes": 5,
        "summary": "原创验收材料，不用于教学。", "level_order": 9999, "textbook_tags": ["QA"],
        "theme": "审核验收", "accumulation_points": ["从"], "reasoning_points": ["动作关系"],
        "reasoning_level": "L1", "content": verified_content(content),
    }


def _create(client: TestClient, payload: dict | None = None) -> dict:
    response = client.post("/api/v1/admin/lessons", json=payload or _payload())
    assert response.status_code == 201, response.json()
    return response.json()["lesson"]


def _start(client: TestClient, lesson_id: str) -> dict:
    created = client.post("/api/v1/profiles", json={"display_name": "审核验收学习者", "school_stage": "JUNIOR"})
    assert created.status_code == 201
    response = client.post("/api/v1/training/sessions", json={
        "profile_id": created.json()["profile"]["id"], "lesson_id": lesson_id,
    })
    assert response.status_code == 201, response.json()
    return response.json()


def test_publish_requires_a_review_of_this_exact_content_version():
    with TestClient(app) as client:
        lesson = _create(client)
        assert lesson["review"]["status"] == "UNREVIEWED"
        blocked = publish(client, lesson["id"])
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "LESSON_REVIEW_REQUIRED"
        reviewed = approve(client, lesson["id"])
        review = reviewed["review"]
        assert len(review["content_version"]) == 12
        assert all(character in "0123456789abcdef" for character in review["content_version"])
        assert review["reviewer"] == "测试教研" and review["reviewed_at"]
        assert review["issues"] == []
        assert reviewed["status"] == "DRAFT", "reviewing is not an implicit publication"
        published = publish(client, lesson["id"])
        assert published.status_code == 200
        assert published.json()["lesson"]["review"] == review
        assert published.json()["lesson"]["status"] == "PUBLISHED"


@pytest.mark.parametrize("stage,field", [
    ("CORE", "source_url"), ("TRANSFER", "source_url"),
    ("CORE", "text_version"), ("TRANSFER", "author"), ("CORE", "era"),
])
def test_missing_provenance_cannot_be_approved_or_published(stage: str, field: str):
    payload = _payload()
    payload["content"][stage]["reading_context"].pop(field)
    with TestClient(app) as client:
        lesson = _create(client, payload)
        rejected = review(client, lesson["id"], {"reviewer": "教研验收"})
        assert rejected.status_code == 422, rejected.json()
        assert rejected.json()["error"]["code"] == "LESSON_REVIEW_NOT_READY"
        assert rejected.json()["error"]["issues"]
        unchanged = client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"]
        assert unchanged["review"]["status"] == "UNREVIEWED"
        assert unchanged["status"] == "DRAFT"
        assert publish(client, lesson["id"]).status_code == 409


def test_review_then_edit_requires_rereview_and_freezes_existing_session():
    with TestClient(app) as client:
        lesson = _create(client)
        lesson_id = lesson["id"]
        old_review = approve(client, lesson_id)["review"]
        assert publish(client, lesson_id).status_code == 200
        old = _start(client, lesson_id)
        old_meta = deepcopy(old["session"]["lesson"])
        assert old_meta["content_version"] == old_review["content_version"]
        assert old_meta["review_status"] == "APPROVED"
        assert old_meta["reviewer"] == old_review["reviewer"]
        assert old_meta["reviewed_at"] == old_review["reviewed_at"]
        old_context = deepcopy(old["session"]["reading_context"])
        content = deepcopy(lesson["content"])
        content["CORE"]["passage"] = "丙从丁学。"
        content["CORE"]["evidence"] = "丁"
        content["CORE"]["reading_context"].update(
            paragraphs=["丙从丁学。"], text_version="test-v2", source_url="https://example.org/revised-source",
        )
        changed = client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={"content": content})
        assert changed.status_code == 200, changed.json()
        draft = changed.json()["lesson"]
        assert draft["status"] == "DRAFT"
        assert draft["review"]["status"] == "STALE"
        assert draft["review"]["content_version"] != old_review["content_version"]
        public = client.get("/api/v1/lessons", params={"school_stage": "JUNIOR"}).json()["lessons"]
        assert lesson_id not in {item["id"] for item in public}
        blocked = publish(client, lesson_id)
        assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "LESSON_REVIEW_REQUIRED"
        frozen = client.get(f"/api/v1/training/sessions/{old['session_id']}").json()["session"]
        assert frozen == old["session"]
        assert frozen["reading_context"] == old_context
        revised_review = approve(client, lesson_id)["review"]
        assert revised_review["content_version"] != old_review["content_version"]
        assert publish(client, lesson_id).status_code == 200
        fresh = _start(client, lesson_id)["session"]
        assert fresh["lesson"]["content_version"] == revised_review["content_version"]
        assert fresh["lesson"]["review_status"] == "APPROVED"
        assert fresh["lesson"]["reviewer"] == revised_review["reviewer"]
        assert fresh["lesson"]["reviewed_at"] == revised_review["reviewed_at"]
        assert fresh["passage"] == "丙从丁学。"
        assert fresh["reading_context"]["text_version"] == "test-v2"
        assert fresh["reading_context"]["source_url"] == "https://example.org/revised-source"
        assert client.get(f"/api/v1/training/sessions/{old['session_id']}").json()["session"] == frozen
        assert frozen["lesson"] == old_meta


def test_exact_noop_save_keeps_a_published_review_but_metadata_edits_do_not():
    with TestClient(app) as client:
        lesson = _create(client)
        lesson_id = lesson["id"]
        review = approve(client, lesson_id)["review"]
        published = publish(client, lesson_id).json()["lesson"]
        unchanged = client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={
            "title": lesson["title"], "theme": lesson["theme"], "content": deepcopy(lesson["content"]),
        })
        assert unchanged.status_code == 200
        assert unchanged.json()["lesson"]["status"] == "PUBLISHED"
        assert unchanged.json()["lesson"]["review"] == review
        assert unchanged.json()["lesson"]["updated_at"] == published["updated_at"]
        revised = client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={"title": "修改教学标题"})
        assert revised.status_code == 200
        assert revised.json()["lesson"]["status"] == "DRAFT"
        assert revised.json()["lesson"]["review"]["status"] == "STALE"


def test_reviewer_is_required_not_just_whitespace():
    with TestClient(app) as client:
        lesson = _create(client)
        response = review(client, lesson["id"], {"reviewer": "   "})
        assert response.status_code == 422
        assert client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"]["review"]["status"] == "UNREVIEWED"


def test_roundtrip_of_resolved_context_is_not_a_new_content_revision():
    payload = _payload()
    for stage in ("CORE", "TRANSFER"):
        payload["content"][stage].pop("reading_context")
        payload["content"][stage].update(source="《论语·述而》", passage="择其善者而从之。", evidence="善者")
    with TestClient(app) as client:
        lesson = _create(client, payload)
        assert all("reading_context" in body for body in lesson["content"].values())
        review_before = deepcopy(lesson["review"])
        saved = client.patch(f"/api/v1/admin/lessons/{lesson['id']}", json={"content": lesson["content"]})
        assert saved.status_code == 200, saved.json()
        assert saved.json()["lesson"]["review"] == review_before
        assert saved.json()["lesson"]["status"] == "DRAFT"
        assert saved.json()["lesson"]["updated_at"] == lesson["updated_at"]


def test_multiple_reviews_in_one_second_select_the_latest_and_freeze_session_attestation(monkeypatch):
    class SameSecondClock(datetime):
        tick = 0

        @classmethod
        def now(cls, tz=None):
            cls.tick += 1
            instant = datetime(2026, 10, 6, 8, 0, 0, cls.tick * 1000, tzinfo=timezone.utc)
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)

    monkeypatch.setattr(main_module, "datetime", SameSecondClock)
    with TestClient(app) as client:
        lesson = _create(client)
        lesson_id = lesson["id"]
        first = review(client, lesson_id, {"reviewer": "第一位教研"})
        assert first.status_code == 200
        old_review = first.json()["lesson"]["review"]
        assert publish(client, lesson_id).status_code == 200
        old = _start(client, lesson_id)
        for reviewer in ("第二位教研", "第三位教研"):
            response = review(client, lesson_id, {"reviewer": reviewer})
            assert response.status_code == 200
            receipt = response.json()["lesson"]["review"]
            assert receipt["reviewer"] == reviewer
            assert receipt["content_version"] == old_review["content_version"]
            assert receipt["reviewed_at"].split(".")[0] == old_review["reviewed_at"].split(".")[0]
        latest = client.get(f"/api/v1/admin/lessons/{lesson_id}").json()["lesson"]["review"]
        assert latest["reviewer"] == "第三位教研"
        assert latest["reviewed_at"] > old_review["reviewed_at"]
        fresh = _start(client, lesson_id)["session"]["lesson"]
        assert fresh["reviewer"] == latest["reviewer"]
        assert fresh["reviewed_at"] == latest["reviewed_at"]
        assert fresh["content_version"] == latest["content_version"]
        restored = client.get(f"/api/v1/training/sessions/{old['session_id']}").json()["session"]
        assert restored == old["session"]
        assert restored["lesson"]["reviewer"] == "第一位教研"


@pytest.mark.parametrize("passage,paragraphs", [
    ("甲从乙学。", ["戊从己学。"]),
    ("甲从乙学。丙从丁学。", ["甲从乙学。", "中间还有一整句。丙从丁学。"]),
])
def test_shared_target_word_cannot_hide_wrong_source_or_noncontinuous_splicing(passage, paragraphs):
    payload = _payload()
    payload["content"]["CORE"]["passage"] = passage
    payload["content"]["CORE"]["reading_context"]["paragraphs"] = paragraphs
    with TestClient(app) as client:
        lesson = _create(client, payload)
        response = review(client, lesson["id"], {"reviewer": "题源验收"})
        assert response.status_code == 422, response.json()
        assert response.json()["error"]["code"] == "LESSON_REVIEW_NOT_READY"
        assert response.json()["error"]["issues"]
        fresh = client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"]
        assert fresh["review"]["status"] == "UNREVIEWED"
        assert fresh["review"]["reviewer"] is None and fresh["review"]["reviewed_at"] is None
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(LessonReview).where(LessonReview.lesson_id == lesson["id"])) == 0


def test_continuous_source_matching_allows_only_punctuation_and_whitespace_variation():
    payload = _payload()
    payload["content"]["CORE"]["passage"] = "甲从乙学，择善而从之。"
    payload["content"]["CORE"]["reading_context"]["paragraphs"] = ["前有介绍。甲 从乙学；择善而从之！后有结语。"]
    with TestClient(app) as client:
        lesson = _create(client, payload)
        reviewed = approve(client, lesson["id"])
        assert reviewed["review"]["issues"] == []
        assert publish(client, lesson["id"]).status_code == 200


def test_old_tab_cannot_approve_a_revision_it_has_not_read_or_write_an_audit():
    with TestClient(app) as client:
        lesson = _create(client)
        old_version = lesson["review"]["content_version"]
        changed = client.patch(f"/api/v1/admin/lessons/{lesson['id']}", json={"title": "另一个标签页修改的题目"})
        assert changed.status_code == 200
        current = changed.json()["lesson"]
        assert current["review"]["content_version"] != old_version
        blocked = client.post(f"/api/v1/admin/lessons/{lesson['id']}/review", json={
            "reviewer": "旧标签页教研", "expected_content_version": old_version,
        })
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "LESSON_REVIEW_VERSION_CONFLICT"
        assert client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"] == current
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(LessonReview).where(LessonReview.lesson_id == lesson["id"])) == 0


def test_old_tab_cannot_publish_even_when_the_new_revision_is_approved():
    with TestClient(app) as client:
        lesson = _create(client)
        old_version = approve(client, lesson["id"])["review"]["content_version"]
        assert client.patch(f"/api/v1/admin/lessons/{lesson['id']}", json={"title": "新版本教学标题"}).status_code == 200
        current = approve(client, lesson["id"])
        assert current["review"]["content_version"] != old_version
        assert current["status"] == "DRAFT"
        blocked = client.post(f"/api/v1/admin/lessons/{lesson['id']}/publish", json={"expected_content_version": old_version})
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "LESSON_PUBLISH_VERSION_CONFLICT"
        assert client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"] == current
        assert publish(client, lesson["id"]).status_code == 200


def test_old_tab_patch_cannot_overwrite_a_newer_revision_or_unpublish_it():
    with TestClient(app) as client:
        lesson = _create(client)
        old_version = lesson["review"]["content_version"]
        edited = client.patch(f"/api/v1/admin/lessons/{lesson['id']}", json={
            "expected_content_version": old_version, "title": "新标签页已保存的题目",
        })
        assert edited.status_code == 200
        approve(client, lesson["id"])
        current = publish(client, lesson["id"]).json()["lesson"]
        blocked = client.patch(f"/api/v1/admin/lessons/{lesson['id']}", json={
            "expected_content_version": old_version, "title": "旧标签页误覆盖", "content": lesson["content"],
        })
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "LESSON_EDIT_VERSION_CONFLICT"
        assert client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"] == current
        assert current["status"] == "PUBLISHED"


@pytest.mark.parametrize("action,fields", [("review", {"reviewer": "教研"}), ("publish", {})])
def test_approval_and_publication_require_the_visible_content_version(action, fields):
    with TestClient(app) as client:
        lesson = _create(client)
        response = client.post(f"/api/v1/admin/lessons/{lesson['id']}/{action}", json=fields)
        assert response.status_code == 422
        assert client.get(f"/api/v1/admin/lessons/{lesson['id']}").json()["lesson"] == lesson
