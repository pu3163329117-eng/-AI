from __future__ import annotations

import hashlib
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
try:
    from backend.access import authorize_request, require_production_storage, security_headers, student_response
    from backend.auth.models import ProfileOwner
    from backend.auth.routes import router as auth_router
    from backend.auth.settings import load_access_settings
    from backend.concurrency import BetaConcurrencyLimit
except ModuleNotFoundError:
    from access import authorize_request, require_production_storage, security_headers, student_response
    from auth.models import ProfileOwner
    from auth.routes import router as auth_router
    from auth.settings import load_access_settings
    from concurrency import BetaConcurrencyLimit

try:
    # Local development imports the backend package from the repository root.
    from backend.config import API_PREFIX
    from backend.db.init import init_db
    from backend.db.models import CommandReceipt, LearnerProfile, Lesson, LessonContent, LessonReview, TrainingEvent, TrainingSession
    from backend.db.session import get_db
    from backend.db.knowledge import knowledge_coverage, knowledge_lookup
    from backend.db.evidence_basis import resolve_annotation_basis
    from backend.db.observations import persist_observations
    from backend.domain.training import apply_command, initial_snapshot
    from backend.domain.reading_context import reading_context_for, validate_reading_context
    from backend.domain.editorial import content_fingerprint, review_readiness
    from backend.schemas import ContentVersionRequest, CreateAdminLessonRequest, CommandRequest, CreateProfileRequest, CreateSessionRequest, LessonContentRequest, ReviewAdminLessonRequest, UpdateAdminLessonRequest
except ModuleNotFoundError:
    # Vercel packages this service with backend/ as its working root.
    from config import API_PREFIX
    from db.init import init_db
    from db.models import CommandReceipt, LearnerProfile, Lesson, LessonContent, LessonReview, TrainingEvent, TrainingSession
    from db.session import get_db
    from db.knowledge import knowledge_coverage, knowledge_lookup
    from db.evidence_basis import resolve_annotation_basis
    from db.observations import persist_observations
    from domain.training import apply_command, initial_snapshot
    from domain.reading_context import reading_context_for, validate_reading_context
    from domain.editorial import content_fingerprint, review_readiness
    from schemas import ContentVersionRequest, CreateAdminLessonRequest, CommandRequest, CreateProfileRequest, CreateSessionRequest, LessonContentRequest, ReviewAdminLessonRequest, UpdateAdminLessonRequest

DbSession = Annotated[Session, Depends(get_db)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Production configuration must fail closed before any worker/tool starts.
    require_production_storage(load_access_settings())
    init_db()
    try:
        try:
            from backend.collaboration import controller as collaboration_controller
        except ModuleNotFoundError:
            from collaboration import controller as collaboration_controller
        collaboration_controller.startup()
        yield
    finally:
        collaboration_controller.shutdown()


def require_guided_training_contract(request: Request) -> None:
    # This is not a permission grant: the app-wide auth/owner/CSRF guard runs first.
    if request.headers.get('X-Wenyan-Training-Contract') != 'guided-v1':
        raise HTTPException(status_code=409, detail='网站已更新，本次未新增提交。请先复制未保存的内容，再刷新页面核对已保存进度；此前未确认的提交可能已经保存，请勿重复提交。')


app = FastAPI(title="文言·推理 API", version="0.1.0", lifespan=lifespan, dependencies=[Depends(authorize_request)])
app.middleware('http')(security_headers)
app.add_middleware(BetaConcurrencyLimit)
app.include_router(auth_router)
try:
    from backend.experience_routes import router as experience_router
except ModuleNotFoundError:
    from experience_routes import router as experience_router
app.include_router(experience_router)
try:
    from backend.support_admin_routes import router as support_admin_router
except ModuleNotFoundError:
    from support_admin_routes import router as support_admin_router
app.include_router(support_admin_router)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # Pydantic's default diagnostics may echo submitted passwords/invites.
    if request.url.path.startswith(('/api/v1/auth/', '/api/v1/support/', '/api/v1/experience/', '/api/v1/admin/support/')):
        code = 'SUPPORT_ADMIN_INVALID_INPUT' if request.url.path.startswith('/api/v1/admin/support/') else 'AUTH_INVALID_INPUT' if request.url.path.startswith('/api/v1/auth/') else 'EXPERIENCE_INVALID_INPUT'
        return JSONResponse({'error': {'code': code}}, status_code=422, headers={'Cache-Control': 'no-store'})
    return await request_validation_exception_handler(request, exc)

# Separate local editorial endpoints from the learner's state machine.
try:
    from backend.knowledge_routes import router as knowledge_review_router
except ModuleNotFoundError:
    from knowledge_routes import router as knowledge_review_router
app.include_router(knowledge_review_router)

try:
    from backend.assessment_routes import router as assessment_router
except ModuleNotFoundError:
    from assessment_routes import router as assessment_router
app.include_router(assessment_router)

try:
    from backend.assessment_editorial_routes import router as assessment_editorial_router
except ModuleNotFoundError:
    from assessment_editorial_routes import router as assessment_editorial_router
app.include_router(assessment_editorial_router)

try:
    from backend.ability_routes import router as ability_router
except ModuleNotFoundError:
    from ability_routes import router as ability_router
app.include_router(ability_router)

try:
    from backend.observation_routes import router as observation_router
except ModuleNotFoundError:
    from observation_routes import router as observation_router
app.include_router(observation_router, dependencies=[Depends(require_guided_training_contract)])

try:
    from backend.ai_routes import router as ai_router
except ModuleNotFoundError:
    from ai_routes import router as ai_router
app.include_router(ai_router)

try:
    from backend.ai_review_routes import router as ai_review_router
except ModuleNotFoundError:
    from ai_review_routes import router as ai_review_router
app.include_router(ai_review_router)

try:
    from backend.collaboration.routes import router as collaboration_router
except ModuleNotFoundError:
    from collaboration.routes import router as collaboration_router
app.include_router(collaboration_router)


@app.exception_handler(HTTPException)
async def api_error(_: Request, exc: HTTPException) -> JSONResponse:
    """Keep API errors stable for web and mobile clients rather than exposing FastAPI's `detail` envelope."""
    error = exc.detail if isinstance(exc.detail, dict) else {"code": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": error}, headers=exc.headers)


def _session_payload(record: TrainingSession) -> dict:
    return student_response({"session_id": record.id, "session": record.snapshot})


def _hash_request(command: CommandRequest) -> str:
    return hashlib.sha256(command.model_dump_json().encode("utf-8")).hexdigest()


def _profile_payload(profile: LearnerProfile) -> dict:
    return {
        "id": profile.id,
        "display_name": profile.display_name,
        "school_stage": profile.school_stage,
        "total_points": profile.total_points,
        "completed_levels": profile.completed_levels,
    }


def _review_session_payload(record: TrainingSession) -> dict:
    snapshot = record.snapshot
    return {
        "session_id": record.id,
        "source": snapshot["source"],
        "stage": snapshot["stage"],
        "completed": snapshot["completed"],
        "feedback": snapshot["feedback"],
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
    }


def _local_calendar_date(value: datetime | None) -> date | None:
    """Database timestamps are UTC; learner calendar dates use UTC+08:00.

    SQLite strips timezone information from UTC event and server timestamps.
    Restore UTC before conversion, rather than silently treating them as local.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone(timedelta(hours=8))).date()


def _earned_points(snapshot: dict) -> int:
    """Read session points defensively so imported/older snapshots remain safe."""
    summary = snapshot.get("summary") or snapshot.get("lesson_summary") or {}
    points = summary.get("earned_points", 0) if isinstance(summary, dict) else 0
    return points if isinstance(points, int) and not isinstance(points, bool) else 0


def _learning_summary(profile: LearnerProfile, records: list[TrainingSession], events: list[TrainingEvent]) -> dict:
    """Build a learner-facing aggregate without mutating the source learning record."""
    completed = [record for record in records if record.snapshot.get("completed")]
    completed_session_ids = {record.id for record in completed}
    completion_events = {
        event.session_id: event
        for event in events
        if event.session_id in completed_session_ids and event.type == "training.session_completed"
    }

    # A pre-event historical completed session still contributes via its last update.
    activity: dict[date, dict[str, int]] = {}
    completion_days: set[date] = set()
    for record in completed:
        event = completion_events.get(record.id)
        completed_on = _local_calendar_date(event.created_at if event else record.updated_at)
        if completed_on is None:
            continue
        completion_days.add(completed_on)
        bucket = activity.setdefault(completed_on, {"points": 0, "completed_sessions": 0})
        bucket["points"] += _earned_points(record.snapshot)
        bucket["completed_sessions"] += 1

    streak = 0
    current_day = _local_calendar_date(datetime.now(timezone.utc))
    while current_day in completion_days:
        streak += 1
        current_day -= timedelta(days=1)

    attempts_by_skill: dict[str, dict[str, int]] = {}
    records_by_id = {record.id: record for record in records}
    for event in events:
        record = records_by_id.get(event.session_id)
        if record is None:
            continue
        # Stage transitions can change the snapshot's target word. Use the
        # immutable attempt, not the latest displayed word. Older events are
        # honestly grouped as unspecified instead of guessing their target.
        variable = event.payload.get("variable")
        label = f"词义判断·{variable}" if isinstance(variable, str) and variable.strip() else "历史判断·未记录目标词"
        stats = attempts_by_skill.setdefault(label, {"attempts": 0, "correct": 0})
        if event.type == "training.attempt_evaluated":
            stats["attempts"] += 1
            if event.payload.get("label") == "CORRECT_BUT_GUESSING":
                stats["correct"] += 1
        elif event.type in {"training.answer_validated", "training.transfer_validated"}:
            stats["attempts"] += 1
            stats["correct"] += 1

    skill_statistics = [
        {
            "label": label,
            "attempts": stats["attempts"],
            "accuracy": round(stats["correct"] / stats["attempts"], 3),
        }
        for label, stats in attempts_by_skill.items()
        if stats["attempts"]
    ]
    skill_statistics.sort(key=lambda item: item["label"])
    weak_skills = [item for item in skill_statistics if attempts_by_skill[item["label"]]["correct"] < item["attempts"]]
    weak_skills.sort(key=lambda item: (item["accuracy"], -item["attempts"], item["label"]))

    completed_lessons = {
        record.snapshot.get("lesson", {}).get("id") or record.lesson_id
        for record in completed
        if record.snapshot.get("lesson", {}).get("id") or record.lesson_id
    }
    recent_activity = [
        {"date": completed_on.isoformat(), **activity[completed_on]}
        for completed_on in sorted(activity, reverse=True)
    ]
    return {
        "total_points": profile.total_points,
        "completed_lessons": len(completed_lessons),
        "completed_sessions": len(completed),
        "current_streak_days": streak,
        "weak_skills": weak_skills,
        "skill_statistics": skill_statistics,
        "recent_activity": recent_activity,
    }


def _saved_evidence_count(records: list[TrainingSession], events: list[TrainingEvent]) -> int:
    """Count saved positions, not reason edits, clicks or semantic correctness."""
    record_ids = {record.id for record in records}
    anchors = set()
    positioned_stages = set()
    legacy_stages = set()
    for event in events:
        if event.session_id not in record_ids or not isinstance(event.payload, dict):
            continue
        payload = event.payload
        stage = payload.get("stage")
        if event.type == "training.evidence_selected":
            # Old preset events had no offsets. At most one per frozen stage;
            # a positioned save in that stage supersedes this uncertain anchor.
            legacy_stages.add((event.session_id, stage if stage in ("CORE", "TRANSFER") else "UNKNOWN"))
        elif event.type == "training.reasoning_saved":
            evidence = payload.get("evidence")
            if stage not in ("CORE", "TRANSFER") or type(payload.get("schema_version")) is not int or payload.get("schema_version") != 1 or not isinstance(evidence, dict):
                continue
            version, source = payload.get("text_version"), payload.get("source")
            paragraph, token = evidence.get("paragraph"), evidence.get("token")
            paragraph_index, start, end = (evidence.get(key) for key in ("paragraph_index", "start", "end"))
            if (not isinstance(version, str) or not version.strip() or not isinstance(source, str) or not source.strip()
                or any(type(value) is not int for value in (paragraph_index, start, end))
                or paragraph_index < 0 or not isinstance(paragraph, str) or not isinstance(token, str)
                or not 0 <= start < end <= len(paragraph) or end - start > 80 or paragraph[start:end] != token or not token.strip()):
                continue
            anchors.add((event.session_id, stage, source, version, paragraph_index, start, end))
            positioned_stages.add((event.session_id, stage))
    known_stage_sessions = {session_id for session_id, _ in positioned_stages} | {session_id for session_id, stage in legacy_stages if stage != "UNKNOWN"}
    # An unlabelled old event may be the same action as a labelled preset or
    # positioned save. Never invent an additional distinct evidence position.
    unpositioned = {key for key in legacy_stages - positioned_stages if key[1] != "UNKNOWN" or key[0] not in known_stage_sessions}
    return len(anchors) + len(unpositioned)


def _achievements_payload(profile: LearnerProfile, records: list[TrainingSession], events: list[TrainingEvent]) -> dict:
    """Derive small, explainable milestones from the immutable learning record.

    Achievements intentionally remain calculated rather than persisted: a repaired or
    imported learning record is reflected immediately and no secondary write model can
    drift out of sync with sessions/events.
    """
    summary = _learning_summary(profile, records, events)
    completed_sessions = max(0, int(summary["completed_sessions"]))
    evidence_selected = _saved_evidence_count(records, events)
    current_streak = max(0, int(summary["current_streak_days"]))

    definitions = (
        ("FIRST_COMPLETION", "首次完成", "完成 1 次完整的语境推理训练。", completed_sessions, 1),
        ("EVIDENCE_KEEPER", "证据守护者", "累计保存 3 处原文证据（记录行为，不代表理由审核通过）。", evidence_selected, 3),
        ("STEADY_READER", "稳定阅读", "连续 3 天完成学习训练。", current_streak, 3),
        ("PERSISTENT_READER", "坚持阅读", "累计完成 5 次完整训练。", completed_sessions, 5),
    )
    achievements = [
        {
            "id": achievement_id,
            "label": label,
            "description": description,
            "unlocked": current >= target,
            "current": current,
            "target": target,
        }
        for achievement_id, label, description, current, target in definitions
    ]

    weak_skills = summary["weak_skills"]
    if weak_skills:
        weak_skill = weak_skills[0]
        accuracy = round(weak_skill["accuracy"] * 100)
        recommendation = {
            "kind": "WEAK_SKILL",
            "title": f"复习：{weak_skill['label']}",
            "description": f"当前正确率为 {accuracy}%，先回到证据线索，再完成一次针对练习。",
            "action_label": "开始复习",
        }
    elif completed_sessions == 0:
        recommendation = {
            "kind": "START",
            "title": "从第一关开始",
            "description": "完成一节语境推理训练，建立你的学习记录。",
            "action_label": "开始今日关卡",
        }
    else:
        recommendation = {
            "kind": "NEXT_LESSON",
            "title": "继续下一关",
            "description": "保持学习节奏，在新的语境中练习用证据判断词义。",
            "action_label": "进入下一关",
        }

    return {"achievements": achievements, "review_recommendation": recommendation}


def _snapshot_text(snapshot: dict, key: str) -> str | None:
    """Read a non-empty string from a frozen session snapshot safely."""
    value = snapshot.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _mistake_review_hint(variable: str, evidence: str | None) -> str:
    """Keep review copy deterministic so it can be trusted across clients."""
    if evidence:
        return f"回到证据“{evidence}”，先判断人物和动作关系，再解释“{variable}”在句中的意思。"
    return f"先回到文中的关键证据，判断人物和动作关系，再解释“{variable}”在句中的意思。"


def _mistakes_payload(db: Session, records: list[TrainingSession], events: list[TrainingEvent]) -> dict:
    """Project WRONG_CONTEXT events into a deduplicated targeted-review list.

    Resolve the wrong attempt's stage, never the session's final display stage.
    Earlier command receipts retain frozen CORE text after transfer overwrites the
    current presentation. Live editorial content must not repair missing history.
    """
    records_by_id = {record.id: record for record in records}
    transfer_sequences: dict[str, list[int]] = {}
    for event in events:
        if event.type == "training.transfer_started":
            transfer_sequences.setdefault(event.session_id, []).append(event.sequence_no)
    frozen_contexts: dict[tuple[str, str], dict | None] = {}

    def wrong_context(record: TrainingSession, event: TrainingEvent) -> dict | None:
        snapshot = record.snapshot
        stage = event.payload.get("stage")
        if stage not in ("CORE", "TRANSFER"):
            transitions = transfer_sequences.get(record.id, [])
            if transitions:
                stage = "TRANSFER" if any(sequence < event.sequence_no for sequence in transitions) else "CORE"
            elif snapshot.get("stage") == "CORE":
                stage = "CORE"  # The one-way state machine has not transferred.
            else:
                return None
        key = (record.id, stage)
        if key not in frozen_contexts:
            context = snapshot if snapshot.get("stage") == stage else snapshot.get("transfer_content") if stage == "TRANSFER" else None
            if not isinstance(context, dict) or not _snapshot_text(context, "passage"):
                receipt = db.scalar(select(CommandReceipt.response).where(
                    CommandReceipt.session_id == record.id,
                    CommandReceipt.response["session"]["stage"].as_string() == stage,
                ).order_by(CommandReceipt.created_at, CommandReceipt.id).limit(1))
                context = receipt.get("session") if isinstance(receipt, dict) else None
            frozen_contexts[key] = context if isinstance(context, dict) and _snapshot_text(context, "passage") else None
        return frozen_contexts[key]
    lesson_ids = {
        record.lesson_id
        for record in records
        if isinstance(record.lesson_id, str) and record.lesson_id
    }
    lessons = {
        lesson.id: lesson
        for lesson in db.scalars(select(Lesson).where(Lesson.id.in_(lesson_ids))).all()
    } if lesson_ids else {}

    grouped: dict[tuple[str, str], dict] = {}
    for event in events:
        if event.type != "training.attempt_evaluated" or not isinstance(event.payload, dict):
            continue
        if event.payload.get("label") != "WRONG_CONTEXT":
            continue
        record = records_by_id.get(event.session_id)
        if record is None or not isinstance(record.snapshot, dict):
            continue
        snapshot = record.snapshot
        lesson_meta = snapshot.get("lesson") if isinstance(snapshot.get("lesson"), dict) else {}
        lesson_id = record.lesson_id or lesson_meta.get("id")
        if not isinstance(lesson_id, str) or not lesson_id:
            # A malformed legacy session cannot form the documented lesson key.
            continue
        context = wrong_context(record, event)
        variable = event.payload.get("variable")
        if not isinstance(variable, str) or not variable.strip():
            variable = _snapshot_text(context, "variable") if context else "目标词未记录"
        if not isinstance(variable, str) or not variable:
            continue

        lesson = lessons.get(lesson_id)
        title = _snapshot_text(lesson_meta, "title") or (lesson.title if lesson else None) or "未命名课程"
        source = _snapshot_text(context, "source") if context else None
        passage = _snapshot_text(context, "passage") if context else None
        evidence = _snapshot_text(context, "evidence") if context else None
        source = source or "历史错答语境未完整保存"
        passage = passage or "该次错答的原文或阶段未完整保存，请回看历史训练核对。"
        review_hint = _mistake_review_hint(variable, evidence) if context else "这条历史错答的语境归属待核对，不将当前题文或新版课程当作当时的错答原文。"
        key = (lesson_id, variable)
        latest_at = event.created_at
        utc_at = latest_at.replace(tzinfo=timezone.utc) if latest_at and latest_at.tzinfo is None else latest_at
        latest_order = (utc_at.timestamp() if utc_at else 0, event.session_id, event.sequence_no)
        current = grouped.get(key)
        if current is None:
            grouped[key] = {
                "lesson_id": lesson_id,
                "title": title,
                "source": source,
                "variable": variable,
                "passage": passage,
                "wrong_attempts": 1,
                "latest_attempt_at": latest_at,
                "review_hint": review_hint,
                "_latest_order": latest_order,
            }
            continue

        current["wrong_attempts"] += 1
        if latest_order > current["_latest_order"]:
            current.update(
                title=title,
                source=source,
                passage=passage,
                latest_attempt_at=latest_at,
                review_hint=review_hint,
                _latest_order=latest_order,
            )

    mistakes = sorted(
        grouped.values(),
        key=lambda item: (
            -item["wrong_attempts"],
            -(item["latest_attempt_at"].timestamp() if item["latest_attempt_at"] else 0),
            item["lesson_id"],
            item["variable"],
        ),
    )
    return {
        "mistakes": [
            {
                "lesson_id": item["lesson_id"],
                "title": item["title"],
                "source": item["source"],
                "variable": item["variable"],
                "passage": item["passage"],
                "wrong_attempts": item["wrong_attempts"],
                "latest_attempt_at": item["latest_attempt_at"].isoformat() if item["latest_attempt_at"] else None,
                "review_hint": item["review_hint"],
            }
            for item in mistakes
        ]
    }


def _lesson_payload(lesson: Lesson) -> dict:
    """Public catalogue shape: content bodies remain private until a learner starts the lesson."""
    return {
        "id": lesson.id,
        "title": lesson.title,
        "source": lesson.source,
        "difficulty": lesson.difficulty,
        "estimated_minutes": lesson.estimated_minutes,
        "summary": lesson.summary,
    }


_PRACTICE_GROUP_FIELDS = {
    "theme": "theme",
    "textbook_tag": "textbook_tags",
    "reasoning_point": "reasoning_points",
}


def _practice_plan_labels(lesson: Lesson, group_by: str) -> list[str]:
    """Read the requested editorial grouping field without exposing draft data.

    Editorial JSON was added after the first locally authored lessons.  Treating
    malformed or blank legacy values as absent keeps the learner catalogue
    predictable instead of inventing an "untagged" plan with no learning value.
    """
    value = getattr(lesson, _PRACTICE_GROUP_FIELDS[group_by])
    candidates = value if isinstance(value, list) else [value]
    return [item.strip() for item in candidates if isinstance(item, str) and item.strip()]


def _practice_plans_payload(db: Session, profile: LearnerProfile, group_by: str) -> dict:
    """Build learner-safe topical plans from the published editorial catalogue."""
    lessons = db.scalars(
        select(Lesson)
        .where(Lesson.school_stage == profile.school_stage, Lesson.status == "PUBLISHED")
        .order_by(Lesson.level_order.asc(), Lesson.id.asc())
    ).all()
    grouped: dict[str, list[Lesson]] = {}
    for lesson in lessons:
        # A repeated tag inside one lesson must not make its count misleading.
        for label in dict.fromkeys(_practice_plan_labels(lesson, group_by)):
            grouped.setdefault(label, []).append(lesson)

    plans = [
        {
            "id": f"{group_by}:{label}",
            "label": label,
            "lesson_count": len(grouped[label]),
            "lessons": [_lesson_payload(lesson) for lesson in grouped[label]],
        }
        for label in sorted(grouped)
    ]
    return {"group_by": group_by, "plans": plans}


def _daily_mission_payload(
    db: Session,
    profile: LearnerProfile,
    records: list[TrainingSession],
    events: list[TrainingEvent],
) -> dict:
    """Build a one-session daily mission entirely from completed learning records."""
    completion_events = {
        event.session_id: event
        for event in events
        if event.type == "training.session_completed"
    }
    today = _local_calendar_date(datetime.now(timezone.utc))
    completed_today = sum(
        1
        for record in records
        if record.snapshot.get("completed")
        and _local_calendar_date(
            completion_events.get(record.id).created_at if record.id in completion_events else record.updated_at
        ) == today
    )
    target = 1
    recommended = _next_lesson(db, profile.school_stage, profile.id)
    return {
        "mission_date": today.isoformat(),
        "target_completed_sessions": target,
        "completed_sessions_today": completed_today,
        "completed": completed_today >= target,
        "recommended_lesson": _lesson_payload(recommended) if recommended else None,
    }


def _editorial_metadata(lesson: Lesson) -> dict:
    """Only teaching fields determine review validity, not publish/timestamps."""
    return {key: getattr(lesson, key) for key in (
        "slug", "title", "school_stage", "level_order", "source", "difficulty",
        "estimated_minutes", "summary", "textbook_tags", "theme", "reasoning_level",
        "accumulation_points", "reasoning_points",
    )}


def _editorial_content_rows(db: Session, lesson: Lesson) -> dict[str, dict]:
    return {row.stage: row.payload for row in db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id)).all()}


def _editorial_hash(db: Session, lesson: Lesson, content: dict | None = None) -> str:
    return content_fingerprint(_editorial_metadata(lesson), content if content is not None else _editorial_content_rows(db, lesson))


def _assert_editorial_version(expected: str | None, fingerprint: str, code: str) -> None:
    if expected is not None and expected != fingerprint[:12]:
        raise HTTPException(status_code=409, detail={"code": code, "current_content_version": fingerprint[:12]})


def _editorial_review_payload(db: Session, lesson: Lesson, content: dict | None = None) -> dict:
    content = content if content is not None else _editorial_content_rows(db, lesson)
    fingerprint = _editorial_hash(db, lesson, content)
    latest = db.scalar(select(LessonReview).where(LessonReview.lesson_id == lesson.id).order_by(LessonReview.created_at.desc(), LessonReview.id.desc()).limit(1))
    reviewed_at = latest.created_at if latest else None
    if reviewed_at is not None:
        reviewed_at = reviewed_at.replace(tzinfo=timezone.utc) if reviewed_at.tzinfo is None else reviewed_at.astimezone(timezone.utc)
    return {
        "status": "UNREVIEWED" if latest is None else "APPROVED" if latest.content_hash == fingerprint else "STALE",
        "content_version": fingerprint[:12],
        "reviewer": latest.reviewer if latest else None,
        "note": latest.note if latest else None,
        # SQLite strips tzinfo; review timestamps are nevertheless stored UTC.
        "reviewed_at": reviewed_at.isoformat() if reviewed_at else None,
        "issues": review_readiness(content),
    }


def _editorial_lesson_payload(db: Session, lesson: Lesson) -> dict:
    """Management-only representation. It may include drafts and content bodies."""
    content = _editorial_content_rows(db, lesson)
    return {
        "id": lesson.id,
        "slug": lesson.slug,
        "title": lesson.title,
        "school_stage": lesson.school_stage,
        "level_order": lesson.level_order,
        "source": lesson.source,
        "difficulty": lesson.difficulty,
        "estimated_minutes": lesson.estimated_minutes,
        "summary": lesson.summary,
        "status": lesson.status,
        "textbook_tags": lesson.textbook_tags,
        "theme": lesson.theme,
        "reasoning_level": lesson.reasoning_level,
        "accumulation_points": lesson.accumulation_points,
        "reasoning_points": lesson.reasoning_points,
        # Show resolved canonical sources in the local editor without modifying
        # seeded rows or any existing learner snapshot.
        "content": {stage: {**payload, "reading_context": reading_context_for(payload)}
                    if isinstance(payload, dict) and isinstance(payload.get("source"), str) and isinstance(payload.get("passage"), str)
                    else payload for stage, payload in content.items()},
        "review": _editorial_review_payload(db, lesson, content),
        "updated_at": lesson.updated_at.isoformat() if lesson.updated_at else None,
    }


_CONTENT_REQUIRED_FIELDS = frozenset(
    {"source", "passage", "variable", "question", "choices", "evidence", "correct_answer", "hints", "validated_feedback"}
)


def _validate_editorial_content(content: LessonContentRequest) -> dict[str, dict]:
    """Reject malformed drafts before they can become learner-visible."""
    normalized = {"CORE": content.CORE, "TRANSFER": content.TRANSFER}
    for stage, payload in normalized.items():
        if "reading_context" in payload and not validate_reading_context(payload["reading_context"]):
            raise HTTPException(status_code=422, detail={"code": "LESSON_READING_CONTEXT_INVALID", "stage": stage})
        missing = sorted(_CONTENT_REQUIRED_FIELDS - set(payload))
        if missing:
            raise HTTPException(status_code=422, detail={"code": "LESSON_CONTENT_INVALID", "stage": stage, "missing": missing})
        strings = _CONTENT_REQUIRED_FIELDS - {"choices", "hints"}
        invalid = sorted(key for key in strings if not isinstance(payload.get(key), str) or not payload[key].strip())
        choices, hints = payload.get("choices"), payload.get("hints")
        if invalid or not isinstance(choices, list) or len(choices) < 2 or not all(isinstance(item, str) and item.strip() for item in choices) or payload["correct_answer"] not in choices or not isinstance(hints, list) or not hints or not all(isinstance(item, str) and item.strip() for item in hints):
            raise HTTPException(status_code=422, detail={"code": "LESSON_CONTENT_INVALID", "stage": stage})
    return normalized


def _replace_editorial_content(db: Session, lesson: Lesson, content: LessonContentRequest) -> None:
    """Replace both authored stages atomically. Existing sessions hold their own copy."""
    payloads = _validate_editorial_content(content)
    existing = {row.stage: row for row in db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id)).all()}
    for stage, payload in payloads.items():
        if stage in existing:
            existing[stage].payload = payload
        else:
            db.add(LessonContent(lesson_id=lesson.id, stage=stage, payload=payload))


def _assert_publishable(db: Session, lesson: Lesson) -> None:
    content = _editorial_content_rows(db, lesson)
    if not {"CORE", "TRANSFER"} <= set(content):
        raise HTTPException(status_code=409, detail={"code": "LESSON_CONTENT_INCOMPLETE"})
    # Reuse the same validation at publication as at editing, guarding old/imported rows too.
    _validate_editorial_content(LessonContentRequest(CORE=content["CORE"], TRANSFER=content["TRANSFER"]))
    review = _editorial_review_payload(db, lesson, content)
    if review["status"] != "APPROVED" or review["issues"]:
        raise HTTPException(status_code=409, detail={"code": "LESSON_REVIEW_REQUIRED", "review": review})


def _lesson_snapshot_meta(db: Session, lesson: Lesson, content: dict[str, dict]) -> dict:
    review = _editorial_review_payload(db, lesson, content)
    approved = review["status"] == "APPROVED" and not review["issues"]
    return {
        "id": lesson.id, "title": lesson.title, "school_stage": lesson.school_stage, "difficulty": lesson.difficulty,
        "content_version": review["content_version"],
        "review_status": review["status"],
        "reviewer": review["reviewer"] if approved else None,
        "reviewed_at": review["reviewed_at"] if approved else None,
    }


def _lesson_content(db: Session, lesson: Lesson, contents: dict[str, dict] | None = None) -> dict:
    contents = contents if contents is not None else _editorial_content_rows(db, lesson)
    if "CORE" not in contents or "TRANSFER" not in contents:
        raise HTTPException(status_code=409, detail={"code": "LESSON_CONTENT_INCOMPLETE"})
    content = dict(contents["CORE"])
    content["transfer"] = contents["TRANSFER"]
    content["summary"] = {
        "accumulation": lesson.summary,
        "reasoning": "先找人物关系和行为线索，再回到目标词判断。",
        "earned_points": 20,
    }
    return content


def _next_lesson(db: Session, school_stage: str, profile_id: str | None = None) -> Lesson | None:
    lessons = db.scalars(
        select(Lesson).where(Lesson.school_stage == school_stage, Lesson.status == "PUBLISHED").order_by(Lesson.level_order.asc())
    ).all()
    if not profile_id:
        return lessons[0] if lessons else None
    completed = {
        record.snapshot.get("lesson", {}).get("id")
        for record in db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
        if record.snapshot.get("completed")
    }
    return next((lesson for lesson in lessons if lesson.id not in completed), None)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "wenyan-api", "database": "sqlite"}


@app.get(f"{API_PREFIX}/lessons")
def list_lessons(db: DbSession, school_stage: str | None = Query(default=None, pattern="^(JUNIOR|SENIOR)$")) -> dict:
    statement = select(Lesson).where(Lesson.status == "PUBLISHED").order_by(Lesson.school_stage.asc(), Lesson.level_order.asc())
    if school_stage:
        statement = statement.where(Lesson.school_stage == school_stage)
    return {"lessons": [_lesson_payload(lesson) for lesson in db.scalars(statement).all()]}


@app.get(f"{API_PREFIX}/lessons/next")
def next_lesson(db: DbSession, school_stage: str = Query(pattern="^(JUNIOR|SENIOR)$"), profile_id: str | None = None) -> dict:
    if profile_id:
        profile = db.get(LearnerProfile, profile_id)
        if not profile:
            raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
        if profile.school_stage != school_stage:
            raise HTTPException(status_code=409, detail={"code": "PROFILE_STAGE_MISMATCH"})
    lesson = _next_lesson(db, school_stage, profile_id)
    return {"lesson": _lesson_payload(lesson) if lesson else None}


@app.get(f"{API_PREFIX}/admin/lessons")
def list_editorial_lessons(
    db: DbSession,
    school_stage: str | None = Query(default=None, pattern="^(JUNIOR|SENIOR)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(DRAFT|PUBLISHED)$"),
) -> dict:
    """Local P0 editorial catalogue. Authentication is intentionally deferred for local development."""
    statement = select(Lesson).order_by(Lesson.school_stage.asc(), Lesson.level_order.asc(), Lesson.created_at.asc())
    if school_stage:
        statement = statement.where(Lesson.school_stage == school_stage)
    if status_filter:
        statement = statement.where(Lesson.status == status_filter)
    return {"lessons": [_editorial_lesson_payload(db, lesson) for lesson in db.scalars(statement).all()]}


@app.post(f"{API_PREFIX}/admin/lessons", status_code=status.HTTP_201_CREATED)
def create_editorial_lesson(request: CreateAdminLessonRequest, db: DbSession) -> dict:
    """Create a non-public draft. Publishing is a separate, deliberate state transition."""
    slug = request.slug or f"draft-{uuid.uuid4().hex[:12]}"
    if db.scalar(select(Lesson.id).where(Lesson.slug == slug)):
        raise HTTPException(status_code=409, detail={"code": "LESSON_SLUG_CONFLICT"})
    values = request.model_dump(exclude={"content", "slug"})
    lesson = Lesson(id=str(uuid.uuid4()), slug=slug, status="DRAFT", **values)
    db.add(lesson)
    db.flush()
    if request.content:
        _replace_editorial_content(db, lesson, request.content)
    db.commit()
    db.refresh(lesson)
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.get(f"{API_PREFIX}/admin/lessons/{{lesson_id}}")
def get_editorial_lesson(lesson_id: str, db: DbSession) -> dict:
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.patch(f"{API_PREFIX}/admin/lessons/{{lesson_id}}")
def update_editorial_lesson(lesson_id: str, request: UpdateAdminLessonRequest, db: DbSession) -> dict:
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    previous_hash = _editorial_hash(db, lesson)
    _assert_editorial_version(request.expected_content_version, previous_hash, "LESSON_EDIT_VERSION_CONFLICT")
    values = request.model_dump(exclude_unset=True, exclude={"content", "expected_content_version"})
    if "slug" in values and values["slug"] != lesson.slug:
        duplicate = db.scalar(select(Lesson.id).where(Lesson.slug == values["slug"], Lesson.id != lesson.id))
        if duplicate:
            raise HTTPException(status_code=409, detail={"code": "LESSON_SLUG_CONFLICT"})
    for field, value in values.items():
        setattr(lesson, field, value)
    if request.content is not None:
        _replace_editorial_content(db, lesson, request.content)
    db.flush()
    # A no-op save preserves publication. Real edits require another human
    # review, while learner sessions keep their frozen content unchanged.
    if lesson.status == "PUBLISHED" and _editorial_hash(db, lesson) != previous_hash:
        lesson.status = "DRAFT"
    db.commit()
    db.refresh(lesson)
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.post(f"{API_PREFIX}/admin/lessons/{{lesson_id}}/review")
def review_editorial_lesson(lesson_id: str, request: ReviewAdminLessonRequest, db: DbSession) -> dict:
    """Record local human approval of this exact version, not login identity."""
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    content = _editorial_content_rows(db, lesson)
    fingerprint = _editorial_hash(db, lesson, content)
    _assert_editorial_version(request.expected_content_version, fingerprint, "LESSON_REVIEW_VERSION_CONFLICT")
    issues = review_readiness(content)
    if issues:
        raise HTTPException(status_code=422, detail={"code": "LESSON_REVIEW_NOT_READY", "issues": issues})
    _validate_editorial_content(LessonContentRequest(CORE=content["CORE"], TRANSFER=content["TRANSFER"]))
    db.add(LessonReview(lesson_id=lesson.id, content_hash=fingerprint, reviewer=request.reviewer, note=request.note, created_at=datetime.now(timezone.utc)))
    db.commit()
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.post(f"{API_PREFIX}/admin/lessons/{{lesson_id}}/publish")
def publish_editorial_lesson(lesson_id: str, request: ContentVersionRequest, db: DbSession) -> dict:
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    _assert_editorial_version(request.expected_content_version, _editorial_hash(db, lesson), "LESSON_PUBLISH_VERSION_CONFLICT")
    _assert_publishable(db, lesson)
    lesson.status = "PUBLISHED"
    db.commit()
    db.refresh(lesson)
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.post(f"{API_PREFIX}/profiles", status_code=status.HTTP_201_CREATED)
def create_profile(request: CreateProfileRequest, db: DbSession, http_request: Request) -> dict:
    user_id = getattr(http_request.state, 'auth_user_id', None)
    if user_id and db.scalar(select(ProfileOwner).where(ProfileOwner.user_id == user_id)):
        raise HTTPException(409, detail={'code': 'PROFILE_ALREADY_EXISTS'})
    profile = LearnerProfile(display_name=request.display_name.strip(), school_stage=request.school_stage)
    if not profile.display_name:
        raise HTTPException(status_code=422, detail={"code": "DISPLAY_NAME_REQUIRED"})
    db.add(profile)
    if user_id:
        # Ownership and the new profile commit atomically; never claim a legacy UUID.
        db.flush()
        db.add(ProfileOwner(profile_id=profile.id, user_id=user_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, detail={'code': 'PROFILE_ALREADY_EXISTS'}) from None
    return {"profile": _profile_payload(profile)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}")
def get_profile(profile_id: str, db: DbSession) -> dict:
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    return {"profile": _profile_payload(profile)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/learning-summary")
def get_learning_summary(profile_id: str, db: DbSession) -> dict:
    """Return the P1 dashboard aggregate for one learner profile."""
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
    session_ids = [record.id for record in records]
    events = (
        db.scalars(select(TrainingEvent).where(TrainingEvent.session_id.in_(session_ids))).all()
        if session_ids
        else []
    )
    return {"summary": _learning_summary(profile, records, events)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/daily-mission")
def get_daily_mission(profile_id: str, db: DbSession) -> dict:
    """Return today's real progress and the next unfinished lesson, if one remains."""
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
    session_ids = [record.id for record in records]
    events = (
        db.scalars(select(TrainingEvent).where(TrainingEvent.session_id.in_(session_ids))).all()
        if session_ids
        else []
    )
    return {"mission": _daily_mission_payload(db, profile, records, events)}


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/practice-plans")
def get_practice_plans(
    profile_id: str,
    db: DbSession,
    group_by: str = Query(default="theme"),
) -> dict:
    """Offer a profile-safe route into the published, authored practice catalogue."""
    if group_by not in _PRACTICE_GROUP_FIELDS:
        raise HTTPException(status_code=422, detail={"code": "INVALID_PRACTICE_GROUP"})
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    return _practice_plans_payload(db, profile, group_by)


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/achievements")
def get_achievements(profile_id: str, db: DbSession) -> dict:
    """Return derived milestone progress plus the learner's single best next action."""
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
    session_ids = [record.id for record in records]
    events = (
        db.scalars(select(TrainingEvent).where(TrainingEvent.session_id.in_(session_ids))).all()
        if session_ids
        else []
    )
    return _achievements_payload(profile, records, events)


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/mistakes")
def get_mistakes(profile_id: str, db: DbSession) -> dict:
    """Return a compact, evidence-led mistake bank for targeted review."""
    profile = db.get(LearnerProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
    session_ids = [record.id for record in records]
    events = (
        db.scalars(select(TrainingEvent).where(TrainingEvent.session_id.in_(session_ids))).all()
        if session_ids
        else []
    )
    return _mistakes_payload(db, records, events)


@app.get(f"{API_PREFIX}/profiles/{{profile_id}}/sessions")
def list_profile_sessions(profile_id: str, db: DbSession) -> dict:
    if not db.get(LearnerProfile, profile_id):
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    records = db.scalars(
        select(TrainingSession)
        .where(TrainingSession.profile_id == profile_id)
        .order_by(TrainingSession.updated_at.desc())
        .limit(20)
    ).all()
    return {"sessions": [_review_session_payload(record) for record in records]}


@app.post(f"{API_PREFIX}/training/sessions", status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_guided_training_contract)])
def create_session(request: CreateSessionRequest, db: DbSession) -> dict:
    profile = db.get(LearnerProfile, request.profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail={"code": "PROFILE_NOT_FOUND"})
    if request.lesson_id:
        lesson = db.get(Lesson, request.lesson_id)
        if not lesson or lesson.status != "PUBLISHED":
            raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    else:
        lesson = _next_lesson(db, profile.school_stage, profile.id)
        if not lesson:
            raise HTTPException(status_code=404, detail={"code": "NEXT_LESSON_NOT_FOUND"})
    if lesson.school_stage != profile.school_stage:
        raise HTTPException(status_code=409, detail={"code": "LESSON_STAGE_MISMATCH"})
    # Resolve sources once so the new training snapshot and its version refer
    # to exactly the same material, even if editorial defaults later change.
    authored = _editorial_content_rows(db, lesson)
    frozen = {stage: {**payload, "reading_context": reading_context_for(payload)} for stage, payload in authored.items()}
    snapshot = initial_snapshot(_lesson_content(db, lesson, frozen), _lesson_snapshot_meta(db, lesson, frozen))
    snapshot["profile_id"] = profile.id
    record = TrainingSession(profile_id=profile.id, lesson_id=lesson.id, state_version=snapshot["state_version"], snapshot=snapshot)
    db.add(record)
    db.commit()
    return _session_payload(record)


@app.get(f"{API_PREFIX}/training/sessions/{{session_id}}", dependencies=[Depends(require_guided_training_contract)])
def get_session(session_id: str, db: DbSession) -> dict:
    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    return student_response({"session": record.snapshot})


@app.get("/api/knowledge/coverage")
def get_knowledge_coverage(db: DbSession) -> dict:
    return knowledge_coverage(db)


@app.get("/api/knowledge/lookup")
def lookup_knowledge(
    db: DbSession,
    session_id: str = Query(min_length=1, max_length=36),
    paragraph_index: int = Query(ge=0),
    start: int = Query(ge=0),
    end: int = Query(ge=1),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=5, ge=1, le=25),
) -> dict:
    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    try:
        return knowledge_lookup(db, record.snapshot, paragraph_index, start, end, offset, limit)
    except ValueError as error:
        raise HTTPException(status_code=422, detail={"code": "INVALID_KNOWLEDGE_SELECTION"}) from error


@app.post(f"{API_PREFIX}/training/sessions/{{session_id}}/commands", dependencies=[Depends(require_guided_training_contract)])
def command(
    session_id: str,
    request: CommandRequest,
    db: DbSession,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict:
    if not idempotency_key:
        raise HTTPException(status_code=400, detail={"code": "IDEMPOTENCY_KEY_REQUIRED"})

    request_hash = _hash_request(request)
    receipt = db.scalar(select(CommandReceipt).where(CommandReceipt.session_id == session_id, CommandReceipt.idempotency_key == idempotency_key))
    if receipt:
        if receipt.request_hash != request_hash:
            raise HTTPException(status_code=409, detail={"code": "IDEMPOTENCY_KEY_REUSED"})
        return student_response(receipt.response)

    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    if request.expected_state_version != record.state_version:
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT", "current_state_version": record.state_version})

    try:
        annotation = resolve_annotation_basis(db, record.snapshot, request.payload) if request.type == "SAVE_REASONING" and request.payload.get("basis_kind") == "ANNOTATION" else None
        result = apply_command(record.snapshot, request.model_dump(), resolved_annotation=annotation)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": str(exc)}) from exc

    # Optimistic update is the concurrency boundary; no process-global lock is needed.
    updated = db.execute(
        update(TrainingSession)
        .where(TrainingSession.id == session_id, TrainingSession.state_version == request.expected_state_version)
        .values(state_version=result.snapshot["state_version"], snapshot=result.snapshot)
    )
    if updated.rowcount != 1:
        db.rollback()
        current = db.get(TrainingSession, session_id)
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT", "current_state_version": current.state_version if current else None})

    # A command may emit several events; state_version is not an event counter.
    # The successful session CAS serializes allocation within this transaction.
    event_sequence = db.scalar(select(func.max(TrainingEvent.sequence_no)).where(TrainingEvent.session_id == session_id)) or 0
    source_events = []
    for offset, event in enumerate(result.events, start=1):
        source_event = TrainingEvent(session_id=session_id, sequence_no=event_sequence + offset, type=event["type"], payload=event["payload"])
        db.add(source_event)
        source_events.append(source_event)
    response = {"session_id": session_id, "state": result.state, "state_version": result.snapshot["state_version"], "session": result.snapshot}
    if request.type == "COMPLETE_SESSION":
        profile_id = result.snapshot.get("profile_id")
        profile = db.get(LearnerProfile, profile_id) if profile_id else None
        if profile:
            profile.total_points += result.snapshot["summary"]["earned_points"]
            profile.completed_levels += 1
            response["profile"] = _profile_payload(profile)
    db.add(CommandReceipt(session_id=session_id, idempotency_key=idempotency_key, request_hash=request_hash, response=response))
    try:
        db.flush()
        persist_observations(db, record, result, source_events)
        db.commit()
    except IntegrityError:
        db.rollback()
        raced_receipt = db.scalar(select(CommandReceipt).where(CommandReceipt.session_id == session_id, CommandReceipt.idempotency_key == idempotency_key))
        if raced_receipt and raced_receipt.request_hash == request_hash:
            return student_response(raced_receipt.response)
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT"})
    return student_response(response)


@app.get(f"{API_PREFIX}/training/sessions/{{session_id}}/reasoning", dependencies=[Depends(require_guided_training_contract)])
def reasoning_history(session_id: str, db: DbSession) -> dict:
    if not db.get(TrainingSession, session_id):
        raise HTTPException(404, detail={"code": "SESSION_NOT_FOUND"})
    rows = db.scalars(select(TrainingEvent).where(TrainingEvent.session_id == session_id,
        TrainingEvent.type == "training.reasoning_saved").order_by(TrainingEvent.sequence_no)).all()
    return {"records": [{"sequence_no": row.sequence_no, "created_at": row.created_at.isoformat(),
                         "graph": row.payload} for row in rows]}
