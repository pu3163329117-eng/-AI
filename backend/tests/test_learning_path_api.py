"""Learning-path fixtures use isolated SQLite, never production attestation."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from random import Random
from types import SimpleNamespace
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.sql.dml import Update
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend import ability_routes as routes
from backend.db.session import Base, get_db
from backend.db.models import LearnerProfile, Lesson, LessonContent, LessonReview, TrainingSession
from backend.db.assessment_models import LessonAbility, AssessmentSession, AssessmentResult
from backend.db.learning_path_models import RecommendationPlan, RecommendationTask, LearningPathReceipt
from backend.db.learning_path import lesson_state
from backend.main import _editorial_metadata
from backend.domain.assessment import select_questions, score, SCORING_CONFIG
from backend.domain.assessment_bank import QUESTION_BANK
from backend.domain.editorial import content_fingerprint
from backend.tests.editorial_helpers import verified_content


@pytest.fixture
def setup():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    db.add_all([LearnerProfile(id="profile", display_name="隔离推荐", school_stage="JUNIOR", total_points=13, completed_levels=2),
                LearnerProfile(id="other", display_name="隔离他人", school_stage="SENIOR", total_points=0, completed_levels=0)])
    db.commit()
    app = FastAPI(); app.include_router(routes.router)
    app.dependency_overrides[get_db] = lambda: db

    @app.exception_handler(HTTPException)
    async def error(_request, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    client = TestClient(app)
    yield db, client
    client.close(); db.close(); engine.dispose()


def add_lesson(db, identifier, level="L1", tags=None, extent="EXCERPT", reviewed=True, classified=True, stage="SENIOR"):
    lesson = Lesson(id=identifier, slug=identifier, title="隔离测试课 " + identifier, school_stage=stage,
        source="隔离测试源", level_order=1, difficulty="旧背景", estimated_minutes=1, summary="仅验证开发流程", status="PUBLISHED")
    db.add(lesson); db.flush()
    content = verified_content({
        "CORE": {"source": "隔离测试源", "passage": "甲从乙学。", "variable": "从", "question": "测试词义？",
            "choices": ["跟从学习", "归还"], "evidence": "从乙学", "correct_answer": "跟从学习", "hints": ["测试提示"],
            "validated_feedback": "测试验证", "reading_context": {"extent": extent}},
        "TRANSFER": {"source": "隔离迁移源", "passage": "择善而从。", "variable": "从", "question": "测试迁移？",
            "choices": ["跟从学习", "归还"], "evidence": "择善", "correct_answer": "跟从学习", "hints": ["测试迁移提示"],
            "validated_feedback": "测试迁移验证"}})
    db.add_all([LessonContent(lesson_id=identifier, stage=key, payload=value) for key, value in content.items()])
    fingerprint = content_fingerprint(_editorial_metadata(lesson), content)
    if reviewed:
        db.add(LessonReview(lesson_id=identifier, content_hash=fingerprint, reviewer="隔离测试署名，不是真实审核", note="仅工作流测试"))
    if classified:
        db.add(LessonAbility(lesson_id=identifier, ability_level=level, dimension_tags=tags or ["vocabulary"],
            version=1, actor="隔离测试标定", note="仅工作流测试", content_version=fingerprint[:12]))
    db.commit()
    return lesson


def add_result(db, identifier, mode="PILOT", approved=False, weak=False, when=None, skip=False):
    questions = select_questions(QUESTION_BANK, randomizer=Random(0))
    if approved:
        for question in questions:
            question.update(review_status="APPROVED", reviewer="隔离测试署名，不是真实审核", reviewed_at="2026-10-07T00:00:00Z")
    answers = {}
    counts = {}
    for question in questions:
        name = question["dimension"] + question["difficulty"]
        counts[name] = counts.get(name, 0) + 1
        wrong = next(o["id"] for o in question["options"] if o["id"] != question["answer_id"])
        answers[question["id"]] = None if skip else wrong if weak and question["dimension"] == "vocabulary" and counts[name] == 2 else question["answer_id"]
    snapshot = {"mode": mode, "status": "COMPLETED", "questions": questions, "answers": answers,
        "bank_version": "test-bank", "scoring_version": "test-scoring", "scoring_config": deepcopy(SCORING_CONFIG),
        "self_level": None, "current_index": 23}
    result = score(snapshot)
    snapshot["result"] = deepcopy(result)
    db.add(AssessmentSession(id=identifier, profile_id="profile", mode=mode, status="COMPLETED", state_version=25, snapshot=snapshot))
    db.add(AssessmentResult(session_id=identifier, payload=result, created_at=when or datetime.now(timezone.utc)))
    db.commit()
    return result


def generate(client, level=None, key="generate", profile="profile"):
    return client.post(f"/api/v1/profiles/{profile}/recommendations", headers={"Idempotency-Key": key}, json={"practice_level": level})


def start(client, task, key="start", profile="profile"):
    return client.post(f'/api/v1/profiles/{profile}/recommendations/{task["id"]}/start', headers={"Idempotency-Key": key}, json={})


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


def test_new_profile_null_ability_no_read_side_effects(setup):
    db, client = setup
    for _ in range(3):
        ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
        assert ability["level"] is None and ability["level_status"] == "UNASSESSED"
        assert ability["latest_pilot"] is None and ability["history"] == []
        assert all(d["score"] is None and d["answered_count"] == 0 and d["source_assessment_id"] is None for d in ability["dimensions"].values())
        assert client.get("/api/v1/profiles/profile/recommendations").json() == {"plan": None}
    assert count(db, RecommendationPlan) == count(db, RecommendationTask) == count(db, LearningPathReceipt) == 0
    assert db.get(LearnerProfile, "profile").total_points == 13


def test_pilot_reference_separate_never_formal_or_weakness_input(setup):
    db, client = setup
    add_result(db, "pilot", weak=True)
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert ability["latest_pilot"]["assessment_id"] == "pilot"
    assert not ability["history"][0]["eligible_for_ability"]
    assert all(d["score"] is None and d["answered_count"] == 0 for d in ability["dimensions"].values())
    add_lesson(db, "base-1"); add_lesson(db, "base-2")
    plan = generate(client).json()["plan"]
    assert plan["practice_level"] == "L1" and plan["level_source"] == "FOUNDATION_DEFAULT"
    assert not any(t["category"] == "REINFORCEMENT" for t in plan["tasks"])


def test_formal_label_with_draft_frozen_questions_rejected(setup):
    db, client = setup
    add_result(db, "formal-unreviewed", mode="FORMAL")
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert ability["level"] is None and not ability["history"][0]["eligible_for_ability"]
    assert ability["latest_pilot"] is None


def test_immutable_reviewed_formal_projection_and_pilot_does_not_override(setup):
    db, client = setup
    earlier = datetime.now(timezone.utc) - timedelta(days=1)
    result = add_result(db, "formal", mode="FORMAL", approved=True, when=earlier, weak=True)
    add_result(db, "newer-pilot")
    # Even a divergent mutable session.result cannot replace immutable AssessmentResult.
    row = db.get(AssessmentSession, "formal")
    row.snapshot = {**row.snapshot, "result": {"suggested_level": "L1"}}
    db.commit()
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert ability["source_assessment_id"] == "formal" and ability["level"] == result["suggested_level"] == "L3"
    assert ability["dimensions"]["vocabulary"]["score"] == 50
    assert ability["dimensions"]["translation"]["score"] is None and ability["dimensions"]["transfer"]["answered_count"] == 0
    assert ability["latest_pilot"]["assessment_id"] == "newer-pilot"
    assert ability["assessed_at"].endswith("+00:00")


def test_all_skipped_formal_no_fabricated_zero_or_level(setup):
    db, client = setup
    add_result(db, "skipped", mode="FORMAL", approved=True, skip=True)
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert ability["level"] is None and ability["source_assessment_id"] == "skipped"
    assert all(d["score"] is None for d in ability["dimensions"].values())


def test_new_insufficient_formal_preserves_prior_sufficient_ability(setup):
    db, client = setup
    earlier = datetime.now(timezone.utc) - timedelta(days=1)
    add_result(db, "valid-prior", mode="FORMAL", approved=True, when=earlier)
    add_result(db, "latest-all-skipped", mode="FORMAL", approved=True, skip=True)
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert ability["level"] == "L3" and ability["source_assessment_id"] == "valid-prior"
    assert all(ability["dimensions"][d]["score"] == 100 for d in ("vocabulary", "syntax", "context", "chapter"))
    assert ability["history"][0]["assessment_id"] == "latest-all-skipped"
    assert "不替换" in ability["history"][0]["reason"] and "样本不足" in ability["explanation"]
    plan = generate(client).json()["plan"]
    assert plan["practice_level"] == "L3" and plan["level_source"] == "FORMAL_ASSESSMENT"


def test_history_bounded_but_old_formal_still_recoverable(setup):
    db, client = setup
    base = datetime.now(timezone.utc)
    add_result(db, "old-formal", mode="FORMAL", approved=True, when=base - timedelta(days=30))
    for i in range(22):
        add_result(db, f"pilot-{i}", when=base + timedelta(seconds=i))
    ability = client.get("/api/v1/profiles/profile/ability").json()["ability"]
    assert len(ability["history"]) == 20
    assert ability["latest_pilot"]["assessment_id"] == "pilot-21" and ability["source_assessment_id"] == "old-formal"
    assert all("questions" not in item for item in ability["history"])


def test_empty_queue_real_gaps_and_no_fabricated_classification(setup):
    db, client = setup
    add_lesson(db, "unreviewed", reviewed=False)
    add_lesson(db, "unclassified", classified=False)
    response = generate(client)
    assert response.status_code == 201
    plan = response.json()["plan"]
    assert plan["tasks"] == [] and len(plan["gaps"]) >= 3
    assert "70/20/10" in plan["explanation"]
    assert count(db, RecommendationTask) == 0
    assert db.get(LearnerProfile, "profile").school_stage == "JUNIOR"


def test_unchanged_empty_queue_reused_new_content_rebuilds(setup):
    db, client = setup
    first = generate(client).json()["plan"]
    repeated = generate(client, key="empty-again")
    assert repeated.status_code == 200 and repeated.json()["plan"]["id"] == first["id"]
    assert count(db, RecommendationPlan) == 1 and count(db, RecommendationTask) == 0
    add_lesson(db, "newly-reviewed")
    rebuilt = generate(client, key="new-content").json()["plan"]
    assert rebuilt["id"] != first["id"] and len(rebuilt["tasks"]) == 1
    assert count(db, RecommendationPlan) == 2


def test_shared_task_start_uses_current_plan_category_and_one_session(setup):
    db, client = setup
    add_lesson(db, "base", "L1"); add_lesson(db, "shared", "L2")
    earlier = generate(client, "L1").json()["plan"]
    old_item = next(task for task in earlier["tasks"] if task["lesson_id"] == "shared")
    assert old_item["category"] == "CHALLENGE"
    current = generate(client, "L2", key="new-practice-level").json()["plan"]
    new_item = next(task for task in current["tasks"] if task["lesson_id"] == "shared")
    assert new_item["id"] == old_item["id"] and new_item["category"] == "MAIN"
    response = start(client, new_item).json()
    assert response["task"]["category"] == "MAIN" and response["task"]["reason"] == new_item["reason"]
    assert db.get(RecommendationTask, new_item["id"]).payload["category"] == "CHALLENGE"
    assert start(client, old_item, key="old-start-identity").json()["session_id"] == response["session_id"]
    assert count(db, TrainingSession) == 1


def test_start_cas_conflict_rolls_back_new_session(setup, monkeypatch):
    db, client = setup
    add_lesson(db, "start-race")
    task = generate(client).json()["plan"]["tasks"][0]
    execute = db.execute

    def race(statement, *args, **kwargs):
        if isinstance(statement, Update) and statement.table.name == "recommendation_tasks":
            return SimpleNamespace(rowcount=0)
        return execute(statement, *args, **kwargs)

    monkeypatch.setattr(db, "execute", race)
    response = start(client, task)
    assert response.status_code == 409
    assert count(db, TrainingSession) == 0 and db.get(RecommendationTask, task["id"]).session_id is None
    assert count(db, LearningPathReceipt) == 1


def test_generation_head_cas_conflict_rolls_back_new_plan(setup, monkeypatch):
    db, client = setup
    add_lesson(db, "first", "L1"); add_lesson(db, "second", "L2")
    original = generate(client, "L1").json()["plan"]
    execute = db.execute

    def race(statement, *args, **kwargs):
        if isinstance(statement, Update) and statement.table.name == "recommendation_heads":
            return SimpleNamespace(rowcount=0)
        return execute(statement, *args, **kwargs)

    monkeypatch.setattr(db, "execute", race)
    assert generate(client, "L2", key="raced-plan").status_code == 409
    assert count(db, RecommendationPlan) == 1 and count(db, LearningPathReceipt) == 1
    assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["id"] == original["id"]


def test_generate_receipt_replay_conflict_stable_tasks_and_manual_no_regrade(setup):
    db, client = setup
    add_lesson(db, "l1"); add_lesson(db, "l2", "L2"); add_lesson(db, "l3", "L3")
    first = generate(client, "L2")
    assert first.status_code == 201
    plan = first.json()["plan"]
    assert plan["level_source"] == "USER_CHOICE"
    assert {t["category"] for t in plan["tasks"]} == {"MAIN", "CHALLENGE"}
    assert generate(client, "L2").json() == first.json()
    assert generate(client, "L1").status_code == 409
    assert generate(client, "L2", key="second").json()["plan"]["id"] == plan["id"]
    for _ in range(3):
        assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["id"] == plan["id"]
    assert count(db, RecommendationPlan) == 1 and count(db, RecommendationTask) == 2
    assert client.get("/api/v1/profiles/profile/ability").json()["ability"]["level"] is None


def test_formal_shortfall_and_l1_l3_boundary_unique_courses(setup):
    db, client = setup
    add_result(db, "formal", mode="FORMAL", approved=True, weak=True)
    add_lesson(db, "a-l1", "L1"); add_lesson(db, "b-l1", "L1")
    add_lesson(db, "a-l2", "L2"); add_lesson(db, "b-l3", "L3"); add_lesson(db, "c-l3", "L3")
    low = generate(client, "L1").json()["plan"]
    assert {t["category"] for t in low["tasks"]} == {"MAIN", "REINFORCEMENT", "CHALLENGE"}
    assert len({t["lesson_id"] for t in low["tasks"]}) == 3
    high = generate(client, "L3", key="high").json()["plan"]
    assert all(t["ability_level"] in ("L2", "L3") for t in high["tasks"])
    assert len({t["lesson_id"] for t in high["tasks"]}) == len(high["tasks"])
    assert client.get("/api/v1/profiles/profile/ability").json()["ability"]["level"] == "L3"


def test_cross_grade_start_once_freezes_content_no_duplicate_or_points(setup):
    db, client = setup
    add_lesson(db, "cross-grade", stage="SENIOR")
    task = generate(client).json()["plan"]["tasks"][0]
    assert task["status"] == "READY"
    first = start(client, task)
    assert first.status_code == 200
    response = first.json()
    assert response["session"]["lesson"]["school_stage"] == "SENIOR"
    assert response["session"]["profile_id"] == "profile" and response["task"]["status"] == "IN_PROGRESS"
    assert response["session"]["reading_context"]["text_version"] == "test-v1"
    assert start(client, task).json() == response
    assert start(client, task, key="again").json()["session_id"] == response["session_id"]
    assert count(db, TrainingSession) == 1
    profile = db.get(LearnerProfile, "profile")
    assert profile.total_points == 13 and profile.completed_levels == 2
    assert start(client, task, profile="other").status_code == 404


@pytest.mark.parametrize("mutation", ["content", "classification", "unpublish", "review"])
def test_started_frozen_training_restores_after_live_course_changes(setup, mutation):
    db, client = setup
    lesson = add_lesson(db, "frozen-existing")
    task = generate(client).json()["plan"]["tasks"][0]
    response = start(client, task).json()
    original_snapshot = deepcopy(response["session"])
    if mutation == "content":
        content = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson.id, LessonContent.stage == "CORE"))
        content.payload = {**content.payload, "question": "新问题，不改已有训练"}
    elif mutation == "classification":
        db.get(LessonAbility, lesson.id).version += 1
    elif mutation == "unpublish":
        lesson.status = "DRAFT"
    else:
        review = db.scalar(select(LessonReview).where(LessonReview.lesson_id == lesson.id))
        review.content_hash = "obsolete-review-test"
    db.commit()
    current = client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["tasks"][0]
    assert current["status"] == "IN_PROGRESS" and current["unavailable_reason"] is None
    restored = start(client, task, key="resume-after-update").json()
    assert restored["session_id"] == response["session_id"] and restored["session"] == original_snapshot
    assert count(db, TrainingSession) == 1
    session = db.get(TrainingSession, restored["session_id"])
    session.snapshot = {**session.snapshot, "completed": True}; db.commit()
    assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["tasks"][0]["status"] == "COMPLETED"


def test_bad_session_link_cannot_restore_or_count_completion(setup):
    db, client = setup
    add_lesson(db, "bad-link")
    task = generate(client).json()["plan"]["tasks"][0]
    unrelated = TrainingSession(profile_id="other", lesson_id="bad-link", state_version=5, snapshot={"completed": True})
    db.add(unrelated); db.flush()
    db.get(RecommendationTask, task["id"]).session_id = unrelated.id
    db.commit()
    assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["tasks"][0]["status"] == "UNAVAILABLE"
    assert start(client, task).status_code == 409


@pytest.mark.parametrize("mutation", ["content", "classification", "unpublish", "review", "binding"])
def test_expired_task_unavailable_read_only_and_refuse_start(setup, mutation):
    db, client = setup
    lesson = add_lesson(db, "expiry")
    task = generate(client).json()["plan"]["tasks"][0]
    original_plan = deepcopy(db.scalar(select(RecommendationPlan)).payload)
    if mutation == "content":
        content = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson.id, LessonContent.stage == "CORE"))
        content.payload = {**content.payload, "question": "已修改"}
    elif mutation == "classification":
        db.get(LessonAbility, lesson.id).version += 1
    elif mutation == "unpublish":
        lesson.status = "DRAFT"
    elif mutation == "binding":
        db.get(LessonAbility, lesson.id).content_version = None
    else:
        old = db.scalar(select(LessonReview).where(LessonReview.lesson_id == lesson.id))
        db.add(LessonReview(lesson_id=lesson.id, content_hash=old.content_hash, reviewer="隔离测试第二次署名", note="仅验证", created_at=datetime.now(timezone.utc) + timedelta(seconds=1)))
    db.commit()
    refreshed = client.get("/api/v1/profiles/profile/recommendations").json()["plan"]
    assert refreshed["tasks"][0]["status"] == "UNAVAILABLE"
    assert start(client, task).status_code == 409 and count(db, TrainingSession) == 0
    assert db.scalar(select(RecommendationPlan)).payload == original_plan


def test_completion_only_exact_associated_session_old_completion_excluded(setup):
    db, client = setup
    add_lesson(db, "first"); add_lesson(db, "second", "L2")
    db.add(TrainingSession(profile_id="profile", lesson_id="second", state_version=5, snapshot={"completed": True}))
    db.commit()
    plan = generate(client).json()["plan"]
    assert [t["lesson_id"] for t in plan["tasks"]] == ["first"]
    task = plan["tasks"][0]
    unrelated = TrainingSession(profile_id="profile", lesson_id="first", state_version=5, snapshot={"completed": True})
    db.add(unrelated); db.commit()
    assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["tasks"][0]["status"] == "READY"
    started = start(client, task).json()
    session = db.get(TrainingSession, started["session_id"])
    session.snapshot = {**session.snapshot, "completed": True}; db.commit()
    assert client.get("/api/v1/profiles/profile/recommendations").json()["plan"]["tasks"][0]["status"] == "COMPLETED"
    following = generate(client, key="next").json()["plan"]
    assert following["tasks"] == []
    assert db.get(LearnerProfile, "profile").total_points == 13


def test_whole_reading_range_never_excerpt(setup):
    db, client = setup
    add_lesson(db, "excerpt", tags=["chapter"])
    task = generate(client).json()["plan"]["tasks"][0]
    assert task["task_type"] == "FOCUSED_PRACTICE" and task["material_extent"] == "EXCERPT"
    add_lesson(db, "chapter", level="L2", tags=["chapter"], extent="CHAPTER")
    plan = generate(client, "L2", key="whole").json()["plan"]
    assert plan["tasks"][0]["task_type"] == "WHOLE_READING" and plan["tasks"][0]["material_extent"] == "CHAPTER"


def test_wrong_profile_missing_keys_invalid_shapes(setup):
    _, client = setup
    assert client.get("/api/v1/profiles/missing/ability").status_code == 404
    assert client.get("/api/v1/profiles/missing/recommendations").status_code == 404
    assert generate(client, profile="missing").status_code == 404
    assert client.post("/api/v1/profiles/profile/recommendations", json={}).status_code == 400
    assert client.post("/api/v1/profiles/profile/recommendations", headers={"Idempotency-Key": "shape"}, json={"practice_level": "L4"}).status_code == 422
    assert client.post("/api/v1/profiles/profile/recommendations", headers={"Idempotency-Key": "shape"}, json={"score": 100}).status_code == 422


def test_same_key_operation_namespaced_and_empty_start_payload(setup):
    db, client = setup
    add_lesson(db, "namespaced")
    task = generate(client, key="same-key").json()["plan"]["tasks"][0]
    assert start(client, task, key="same-key").status_code == 200
    assert count(db, LearningPathReceipt) == 2
    assert client.post(f'/api/v1/profiles/profile/recommendations/{task["id"]}/start', headers={"Idempotency-Key": "extra"}, json={"lesson_id": "other"}).status_code == 422
