from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


def _content(label: str = "初稿") -> dict:
    return {
        "CORE": {
            "source": "《测试篇》", "passage": f"{label}：甲从乙学。", "variable": "从",
            "question": "从是什么意思？", "choices": ["跟从学习", "归还"], "evidence": "从乙学",
            "correct_answer": "跟从学习", "hints": ["看人物关系。"], "validated_feedback": "判断成立。",
        },
        "TRANSFER": {
            "source": "《测试迁移篇》", "passage": f"{label}：择善而从。", "variable": "从",
            "question": "从是什么意思？", "choices": ["跟从学习", "归还"], "evidence": "择善",
            "correct_answer": "跟从学习", "hints": ["看择善。"], "validated_feedback": "迁移成功。",
        },
    }


def _draft_payload(slug: str, content: dict | None = None) -> dict:
    return {
        "slug": slug, "school_stage": "JUNIOR", "title": "从：编辑测试", "source": "《测试篇》", "difficulty": "基础",
        "estimated_minutes": 6, "summary": "测试内容管理。", "level_order": 88,
        "textbook_tags": ["初中文言文", "实词"], "theme": "人物关系", "accumulation_points": ["从：跟从学习"],
        "reasoning_points": ["人物关系"], "reasoning_level": "L1·语境取证", "content": content,
    }


def test_editorial_draft_publish_catalogue_and_metadata_contract():
    slug = f"admin-draft-{uuid4().hex[:10]}"
    with TestClient(app) as client:
        created = client.post("/api/v1/admin/lessons", json=_draft_payload(slug))
        assert created.status_code == 201
        draft = created.json()["lesson"]
        assert draft["status"] == "DRAFT"
        assert draft["textbook_tags"] == ["初中文言文", "实词"]
        assert draft["content"] == {}

        public_before = client.get("/api/v1/lessons", params={"school_stage": "JUNIOR"})
        assert draft["id"] not in {item["id"] for item in public_before.json()["lessons"]}

        incomplete = client.post(f"/api/v1/admin/lessons/{draft['id']}/publish")
        assert incomplete.status_code == 409
        assert incomplete.json()["error"]["code"] == "LESSON_CONTENT_INCOMPLETE"

        edited = client.patch(f"/api/v1/admin/lessons/{draft['id']}", json={"content": _content()})
        assert edited.status_code == 200
        assert set(edited.json()["lesson"]["content"]) == {"CORE", "TRANSFER"}

        published = client.post(f"/api/v1/admin/lessons/{draft['id']}/publish")
        assert published.status_code == 200
        assert published.json()["lesson"]["status"] == "PUBLISHED"

        listed = client.get("/api/v1/admin/lessons", params={"status": "PUBLISHED", "school_stage": "JUNIOR"})
        assert draft["id"] in {item["id"] for item in listed.json()["lessons"]}
        public_after = client.get("/api/v1/lessons", params={"school_stage": "JUNIOR"})
        assert draft["id"] in {item["id"] for item in public_after.json()["lessons"]}


def test_editorial_draft_generates_slug_when_editor_omits_it():
    payload = _draft_payload("unused-slug")
    payload.pop("slug")

    with TestClient(app) as client:
        response = client.post("/api/v1/admin/lessons", json=payload)

    assert response.status_code == 201
    lesson = response.json()["lesson"]
    assert lesson["status"] == "DRAFT"
    assert lesson["slug"].startswith("draft-")


def test_editorial_updates_do_not_rewrite_an_existing_session_snapshot():
    slug = f"admin-freeze-{uuid4().hex[:10]}"
    with TestClient(app) as client:
        created = client.post("/api/v1/admin/lessons", json=_draft_payload(slug, _content("旧文本")))
        lesson_id = created.json()["lesson"]["id"]
        assert client.post(f"/api/v1/admin/lessons/{lesson_id}/publish").status_code == 200

        profile = client.post("/api/v1/profiles", json={"display_name": "编辑测试学习者", "school_stage": "JUNIOR"}).json()["profile"]
        started = client.post("/api/v1/training/sessions", json={"profile_id": profile["id"], "lesson_id": lesson_id})
        assert started.status_code == 201
        session_id = started.json()["session_id"]
        assert started.json()["session"]["passage"] == "旧文本：甲从乙学。"

        changed = _content("新文本")
        update = client.patch(f"/api/v1/admin/lessons/{lesson_id}", json={"theme": "更新后的主题", "content": deepcopy(changed)})
        assert update.status_code == 200
        assert update.json()["lesson"]["theme"] == "更新后的主题"
        assert update.json()["lesson"]["content"]["CORE"]["passage"] == "新文本：甲从乙学。"

        frozen = client.get(f"/api/v1/training/sessions/{session_id}")
        assert frozen.status_code == 200
        assert frozen.json()["session"]["passage"] == "旧文本：甲从乙学。"
