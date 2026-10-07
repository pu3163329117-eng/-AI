"""Read-only projections and explicit transactional queue generation/start."""
from copy import deepcopy
import hashlib
import json
import uuid
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .models import LearnerProfile, Lesson, LessonContent, LessonReview, TrainingSession
from .assessment_models import AssessmentSession, AssessmentResult, LessonAbility
from .assessment import fail, ensure_profile, utc_iso
from .learning_path_models import RecommendationHead, RecommendationPlan, RecommendationTask, LearningPathReceipt
try:
    from backend.domain.ability import build_ability
    from backend.domain.recommendation import choose
    from backend.domain.reading_context import reading_context_for
    from backend.domain.training import initial_snapshot
except ModuleNotFoundError:
    from domain.ability import build_ability
    from domain.recommendation import choose
    from domain.reading_context import reading_context_for
    from domain.training import initial_snapshot

TASK_PUBLIC = ("id", "lesson_id", "title", "category", "task_type", "ability_level", "dimension_tags", "content_version",
               "source", "material_extent", "reason")


def ability(db, profile_id):
    ensure_profile(db, profile_id)
    rows = db.execute(select(AssessmentSession, AssessmentResult).join(AssessmentResult,
        AssessmentResult.session_id == AssessmentSession.id).where(AssessmentSession.profile_id == profile_id,
        AssessmentSession.status == "COMPLETED").order_by(AssessmentResult.created_at.desc(), AssessmentSession.id.desc())).all()
    return build_ability(profile_id, [{"assessment_id": session.id, "snapshot": session.snapshot, "mode": session.mode,
        "result": result.payload, "completed_at": utc_iso(result.created_at)} for session, result in rows])


def lesson_state(db, lesson_id):
    lesson = db.get(Lesson, lesson_id, populate_existing=True)
    if not lesson or lesson.status != "PUBLISHED":
        return None, "课程已下架或不存在。"
    # Lazy import avoids router-registration cycles and shares the one publication gate.
    try:
        from backend.main import _assert_publishable, _editorial_content_rows, _editorial_hash
    except ModuleNotFoundError:
        from main import _assert_publishable, _editorial_content_rows, _editorial_hash
    try:
        _assert_publishable(db, lesson)
    except HTTPException:
        return None, "课程当前内容尚未通过完整的来源、结构和人工审核检查。"
    content = _editorial_content_rows(db, lesson)
    fingerprint = _editorial_hash(db, lesson, content)
    review = db.scalar(select(LessonReview).where(LessonReview.lesson_id == lesson_id)
        .order_by(LessonReview.created_at.desc(), LessonReview.id.desc()).limit(1))
    if review is None or review.content_hash != fingerprint or not review.reviewer.strip():
        return None, "当前内容版本尚未通过有效人工审核。"
    classification = db.get(LessonAbility, lesson_id, populate_existing=True)
    if not classification or classification.ability_level not in ("L1", "L2", "L3") or not classification.dimension_tags or not classification.actor or not classification.actor.strip():
        return None, "课程尚未完成能力标定。"
    if getattr(classification, "content_version", None) != fingerprint[:12]:
        return None, "能力标定未绑定当前内容版本，需要重新标定。"
    context = reading_context_for(content["CORE"])
    if context.get("extent") not in ("FULL", "CHAPTER", "EXCERPT", "PROMPT"):
        return None, "材料范围无效。"
    return {"lesson": lesson, "content": content, "context": context, "content_hash": fingerprint,
            "review": review, "classification": classification}, None


def task_availability(db, task):
    state, reason = lesson_state(db, task.lesson_id)
    if state is None:
        return None, reason
    payload = task.payload
    if payload["content_hash"] != state["content_hash"] or payload["ability_version"] != state["classification"].version or payload["review_id"] != state["review"].id:
        return None, "课程内容、审核或能力标定已变更，请重新生成推荐。"
    return state, None


def public_task(db, frozen):
    task = db.get(RecommendationTask, frozen["id"], populate_existing=True)
    result = {key: deepcopy(frozen[key]) for key in TASK_PUBLIC}
    result.update(status="UNAVAILABLE", unavailable_reason="任务不存在。", session_id=None)
    if task is None:
        return result
    result["session_id"] = task.session_id
    session = db.get(TrainingSession, task.session_id, populate_existing=True) if task.session_id else None
    if session is not None and (session.profile_id != task.profile_id or (session.snapshot.get("lesson", {}).get("id") or session.lesson_id) != task.lesson_id):
        result["unavailable_reason"] = "关联训练记录与任务不匹配。"
        return result
    if session is not None:
        # A started session owns frozen material. Live edits gate only new starts.
        result.update(status="COMPLETED" if session.snapshot.get("completed") else "IN_PROGRESS", unavailable_reason=None)
        return result
    _, invalid_reason = task_availability(db, task)
    if invalid_reason:
        result["unavailable_reason"] = invalid_reason
    elif task.session_id and (session is None or session.profile_id != task.profile_id):
        result["unavailable_reason"] = "关联训练记录无法恢复。"
    else:
        result.update(status="IN_PROGRESS" if session else "READY", unavailable_reason=None)
    return result


def public_plan(db, plan):
    return {"id": plan.id, "profile_id": plan.profile_id, "created_at": utc_iso(plan.created_at),
        **{key: deepcopy(plan.payload[key]) for key in ("practice_level", "level_source", "gaps", "explanation")},
        "tasks": [public_task(db, item) for item in plan.payload["tasks"]]}


def current_task_item(db, task):
    head = db.get(RecommendationHead, task.profile_id, populate_existing=True)
    current = db.get(RecommendationPlan, head.plan_id) if head else None
    if current:
        item = next((item for item in current.payload["tasks"] if item["id"] == task.id), None)
        if item:
            return item
    return {"id": task.id, **task.payload}


def get_plan(db, profile_id):
    ensure_profile(db, profile_id)
    head = db.get(RecommendationHead, profile_id, populate_existing=True)
    plan = db.get(RecommendationPlan, head.plan_id) if head else None
    return {"plan": public_plan(db, plan) if plan else None}


def digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def receipt(db, profile_id, operation, key, request_hash):
    item = db.scalar(select(LearningPathReceipt).where(LearningPathReceipt.profile_id == profile_id,
        LearningPathReceipt.operation == operation, LearningPathReceipt.idempotency_key == key))
    if item:
        if item.request_hash != request_hash:
            fail("IDEMPOTENCY_KEY_REUSED")
        return deepcopy(item.response)
    return None


def finish_write(db, profile_id, operation, key, request_hash, response):
    db.add(LearningPathReceipt(profile_id=profile_id, operation=operation, idempotency_key=key,
        request_hash=request_hash, response=response))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = receipt(db, profile_id, operation, key, request_hash)
        if previous:
            return previous
        fail("RECOMMENDATION_CONFLICT")
    return response


def generate(db, profile_id, practice_level, key):
    ensure_profile(db, profile_id)
    request_hash = digest({"practice_level": practice_level})
    previous = receipt(db, profile_id, "GENERATE", key, request_hash)
    if previous:
        return previous, False
    projection = ability(db, profile_id)
    level = practice_level or projection["level"] or "L1"
    source = "USER_CHOICE" if practice_level else "FORMAL_ASSESSMENT" if projection["level"] else "FOUNDATION_DEFAULT"
    head = db.get(RecommendationHead, profile_id, populate_existing=True)
    current = db.get(RecommendationPlan, head.plan_id) if head else None
    completed = {session.snapshot.get("lesson", {}).get("id") or session.lesson_id for session in db.scalars(
        select(TrainingSession).where(TrainingSession.profile_id == profile_id)) if session.snapshot.get("completed")}
    candidates, excluded = [], 0
    for lesson in db.scalars(select(Lesson).where(Lesson.status == "PUBLISHED").order_by(Lesson.level_order, Lesson.id)):
        if lesson.id in completed:
            continue
        state, invalid_reason = lesson_state(db, lesson.id)
        if state is None:
            excluded += 1
            continue
        classification, context = state["classification"], state["context"]
        candidates.append({"lesson_id": lesson.id, "title": lesson.title, "ability_level": classification.ability_level,
            "dimension_tags": classification.dimension_tags, "content_hash": state["content_hash"],
            "content_version": state["content_hash"][:12], "ability_version": classification.version,
            "review_id": state["review"].id, "source": lesson.source, "material_extent": context["extent"],
            "task_type": "WHOLE_READING" if context["extent"] in ("FULL", "CHAPTER") and "chapter" in classification.dimension_tags else "FOCUSED_PRACTICE"})
    selected, gaps = choose(candidates, level, projection["dimensions"])
    if excluded:
        gaps.append(f"{excluded} 门已发布课程因未审核、未标定或版本失效暂不参与能力推荐。")
    tasks = []
    for candidate in selected:
        identity = digest({"profile_id": profile_id, **{key: candidate[key] for key in ("lesson_id", "content_hash", "ability_version", "review_id")}})
        task = db.scalar(select(RecommendationTask).where(RecommendationTask.identity_key == identity))
        if task is None:
            task = RecommendationTask(id=str(uuid.uuid4()), profile_id=profile_id, lesson_id=candidate["lesson_id"], identity_key=identity, payload=deepcopy(candidate))
            db.add(task)
        tasks.append({"id": task.id, **candidate})
    payload = {"practice_level": level, "level_source": source,
        "tasks": tasks, "gaps": gaps, "explanation": "这是练习队列，不是重新定级。只列当前可执行的已审核且有效标定内容；课程不足时保留缺口，不宣称已达到 70/20/10。"}
    if current and current.payload == payload:
        return finish_write(db, profile_id, "GENERATE", key, request_hash, {"plan": public_plan(db, current)}), False
    plan = RecommendationPlan(profile_id=profile_id, payload=payload)
    db.add(plan)
    try:
        db.flush()
        if head is None:
            db.add(RecommendationHead(profile_id=profile_id, plan_id=plan.id, version=1))
        else:
            changed = db.execute(update(RecommendationHead).where(RecommendationHead.profile_id == profile_id,
                RecommendationHead.version == head.version).values(plan_id=plan.id, version=head.version + 1), execution_options={"synchronize_session": False})
            if changed.rowcount != 1:
                db.rollback(); fail("RECOMMENDATION_CONFLICT")
        return finish_write(db, profile_id, "GENERATE", key, request_hash, {"plan": public_plan(db, plan)}), True
    except IntegrityError:
        db.rollback()
        previous = receipt(db, profile_id, "GENERATE", key, request_hash)
        if previous:
            return previous, False
        fail("RECOMMENDATION_CONFLICT")


def start(db, profile_id, task_id, key):
    ensure_profile(db, profile_id)
    operation, request_hash = "START:" + task_id, digest({"task_id": task_id})
    previous = receipt(db, profile_id, operation, key, request_hash)
    if previous:
        return previous
    task = db.get(RecommendationTask, task_id, populate_existing=True)
    if not task or task.profile_id != profile_id:
        fail("RECOMMENDATION_TASK_NOT_FOUND", 404)
    if task.session_id:
        existing = db.get(TrainingSession, task.session_id)
        if existing is None or existing.profile_id != profile_id or (existing.snapshot.get("lesson", {}).get("id") or existing.lesson_id) != task.lesson_id:
            fail("RECOMMENDATION_TASK_UNAVAILABLE")
        return finish_write(db, profile_id, operation, key, request_hash,
            {"session_id": existing.id, "session": existing.snapshot, "task": public_task(db, current_task_item(db, task))})
    state, invalid_reason = task_availability(db, task)
    if invalid_reason:
        fail("RECOMMENDATION_TASK_UNAVAILABLE", reason=invalid_reason)
    lesson = state["lesson"]
    frozen = {stage: {**deepcopy(payload), "reading_context": reading_context_for(payload)} for stage, payload in state["content"].items()}
    try:
        from backend.main import _lesson_content, _lesson_snapshot_meta
    except ModuleNotFoundError:
        from main import _lesson_content, _lesson_snapshot_meta
    content = _lesson_content(db, lesson, frozen)
    metadata = _lesson_snapshot_meta(db, lesson, frozen)
    snapshot = initial_snapshot(content, metadata)
    snapshot.update(profile_id=profile_id, recommendation_task_id=task_id)
    session = TrainingSession(profile_id=profile_id, lesson_id=lesson.id, state_version=snapshot["state_version"], snapshot=snapshot)
    db.add(session)
    try:
        db.flush()
        changed = db.execute(update(RecommendationTask).where(RecommendationTask.id == task_id, RecommendationTask.session_id.is_(None))
            .values(session_id=session.id), execution_options={"synchronize_session": False})
        if changed.rowcount != 1:
            db.rollback(); fail("RECOMMENDATION_CONFLICT")
        db.expire(task)
        response = {"session_id": session.id, "session": snapshot, "task": public_task(db, current_task_item(db, task))}
        return finish_write(db, profile_id, operation, key, request_hash, response)
    except IntegrityError:
        db.rollback()
        previous = receipt(db, profile_id, operation, key, request_hash)
        if previous:
            return previous
        fail("RECOMMENDATION_CONFLICT")
