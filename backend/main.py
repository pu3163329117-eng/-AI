from __future__ import annotations

import hashlib
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    # Local development imports the backend package from the repository root.
    from backend.config import API_PREFIX
    from backend.db.init import init_db
    from backend.db.models import CommandReceipt, LearnerProfile, Lesson, LessonContent, TrainingEvent, TrainingSession
    from backend.db.session import get_db
    from backend.domain.training import apply_command, initial_snapshot
    from backend.schemas import CreateAdminLessonRequest, CommandRequest, CreateProfileRequest, CreateSessionRequest, LessonContentRequest, UpdateAdminLessonRequest
except ModuleNotFoundError:
    # Vercel packages this service with backend/ as its working root.
    from config import API_PREFIX
    from db.init import init_db
    from db.models import CommandReceipt, LearnerProfile, Lesson, LessonContent, TrainingEvent, TrainingSession
    from db.session import get_db
    from domain.training import apply_command, initial_snapshot
    from schemas import CreateAdminLessonRequest, CommandRequest, CreateProfileRequest, CreateSessionRequest, LessonContentRequest, UpdateAdminLessonRequest

DbSession = Annotated[Session, Depends(get_db)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="文言·推理 API", version="0.1.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def api_error(_: Request, exc: HTTPException) -> JSONResponse:
    """Keep API errors stable for web and mobile clients rather than exposing FastAPI's `detail` envelope."""
    error = exc.detail if isinstance(exc.detail, dict) else {"code": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": error})


def _session_payload(record: TrainingSession) -> dict:
    return {"session_id": record.id, "session": record.snapshot}


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
    """Return the application's local calendar date for a database timestamp.

    SQLite returns naive timestamps in local application time, while a production
    database can return timezone-aware values.  Converting aware values with
    ``astimezone()`` deliberately uses the app host's local timezone; that keeps
    the streak rule aligned with what a learner sees as "today".
    """
    if value is None:
        return None
    return value.astimezone().date() if value.tzinfo is not None else value.date()


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
    current_day = date.today()
    while current_day in completion_days:
        streak += 1
        current_day -= timedelta(days=1)

    attempts_by_skill: dict[str, dict[str, int]] = {}
    records_by_id = {record.id: record for record in records}
    for event in events:
        record = records_by_id.get(event.session_id)
        if record is None:
            continue
        snapshot = record.snapshot
        variable = snapshot.get("variable")
        label = f"词义判断·{variable}" if isinstance(variable, str) and variable.strip() else "语境推理"
        stats = attempts_by_skill.setdefault(label, {"attempts": 0, "correct": 0})
        if event.type == "training.attempt_evaluated":
            stats["attempts"] += 1
            if event.payload.get("label") == "CORRECT_BUT_GUESSING":
                stats["correct"] += 1
        elif event.type in {"training.answer_validated", "training.transfer_validated"}:
            stats["attempts"] += 1
            stats["correct"] += 1

    weak_skills = [
        {
            "label": label,
            "attempts": stats["attempts"],
            "accuracy": round(stats["correct"] / stats["attempts"], 3),
        }
        for label, stats in attempts_by_skill.items()
        if stats["attempts"] and stats["correct"] < stats["attempts"]
    ]
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
        "recent_activity": recent_activity,
    }


def _achievements_payload(profile: LearnerProfile, records: list[TrainingSession], events: list[TrainingEvent]) -> dict:
    """Derive small, explainable milestones from the immutable learning record.

    Achievements intentionally remain calculated rather than persisted: a repaired or
    imported learning record is reflected immediately and no secondary write model can
    drift out of sync with sessions/events.
    """
    summary = _learning_summary(profile, records, events)
    completed_sessions = max(0, int(summary["completed_sessions"]))
    evidence_selected = max(0, sum(1 for event in events if event.type == "training.evidence_selected"))
    current_streak = max(0, int(summary["current_streak_days"]))

    definitions = (
        ("FIRST_COMPLETION", "首次完成", "完成 1 次完整的语境推理训练。", completed_sessions, 1),
        ("EVIDENCE_KEEPER", "证据守护者", "在判断前累计选出 3 条文本证据。", evidence_selected, 3),
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

    New events record their variable directly. Earlier records did not, so frozen
    session snapshots remain the backwards-compatible source of truth. The snapshot
    also keeps review data available if an editorial lesson is later removed.
    """
    records_by_id = {record.id: record for record in records}
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
        variable = event.payload.get("variable")
        if not isinstance(variable, str) or not variable.strip():
            variable = _snapshot_text(snapshot, "variable")
        if not isinstance(variable, str) or not variable:
            continue

        lesson = lessons.get(lesson_id)
        title = _snapshot_text(lesson_meta, "title") or (lesson.title if lesson else None) or "未命名课程"
        source = _snapshot_text(snapshot, "source") or (lesson.source if lesson else None) or ""
        passage = _snapshot_text(snapshot, "passage") or ""
        evidence = _snapshot_text(snapshot, "evidence")
        key = (lesson_id, variable)
        latest_at = event.created_at
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
                "review_hint": _mistake_review_hint(variable, evidence),
            }
            continue

        current["wrong_attempts"] += 1
        if latest_at and (current["latest_attempt_at"] is None or latest_at > current["latest_attempt_at"]):
            current.update(
                title=title,
                source=source,
                passage=passage,
                latest_attempt_at=latest_at,
                review_hint=_mistake_review_hint(variable, evidence),
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


def _editorial_lesson_payload(db: Session, lesson: Lesson) -> dict:
    """Management-only representation. It may include drafts and content bodies."""
    rows = db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id)).all()
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
        "content": {row.stage: row.payload for row in rows},
        "updated_at": lesson.updated_at.isoformat() if lesson.updated_at else None,
    }


_CONTENT_REQUIRED_FIELDS = frozenset(
    {"source", "passage", "variable", "question", "choices", "evidence", "correct_answer", "hints", "validated_feedback"}
)


def _validate_editorial_content(content: LessonContentRequest) -> dict[str, dict]:
    """Reject malformed drafts before they can become learner-visible."""
    normalized = {"CORE": content.CORE, "TRANSFER": content.TRANSFER}
    for stage, payload in normalized.items():
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
    content = {row.stage: row.payload for row in db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id)).all()}
    if set(content) < {"CORE", "TRANSFER"}:
        raise HTTPException(status_code=409, detail={"code": "LESSON_CONTENT_INCOMPLETE"})
    # Reuse the same validation at publication as at editing, guarding old/imported rows too.
    _validate_editorial_content(LessonContentRequest(CORE=content["CORE"], TRANSFER=content["TRANSFER"]))


def _lesson_snapshot_meta(lesson: Lesson) -> dict:
    return {"id": lesson.id, "title": lesson.title, "school_stage": lesson.school_stage, "difficulty": lesson.difficulty}


def _lesson_content(db: Session, lesson: Lesson) -> dict:
    rows = db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id)).all()
    contents = {row.stage: row.payload for row in rows}
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
    values = request.model_dump(exclude_unset=True, exclude={"content"})
    if "slug" in values and values["slug"] != lesson.slug:
        duplicate = db.scalar(select(Lesson.id).where(Lesson.slug == values["slug"], Lesson.id != lesson.id))
        if duplicate:
            raise HTTPException(status_code=409, detail={"code": "LESSON_SLUG_CONFLICT"})
    for field, value in values.items():
        setattr(lesson, field, value)
    if request.content is not None:
        _replace_editorial_content(db, lesson, request.content)
    db.commit()
    db.refresh(lesson)
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.post(f"{API_PREFIX}/admin/lessons/{{lesson_id}}/publish")
def publish_editorial_lesson(lesson_id: str, db: DbSession) -> dict:
    lesson = db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(status_code=404, detail={"code": "LESSON_NOT_FOUND"})
    _assert_publishable(db, lesson)
    lesson.status = "PUBLISHED"
    db.commit()
    db.refresh(lesson)
    return {"lesson": _editorial_lesson_payload(db, lesson)}


@app.post(f"{API_PREFIX}/profiles", status_code=status.HTTP_201_CREATED)
def create_profile(request: CreateProfileRequest, db: DbSession) -> dict:
    profile = LearnerProfile(display_name=request.display_name.strip(), school_stage=request.school_stage)
    if not profile.display_name:
        raise HTTPException(status_code=422, detail={"code": "DISPLAY_NAME_REQUIRED"})
    db.add(profile)
    db.commit()
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


@app.post(f"{API_PREFIX}/training/sessions", status_code=status.HTTP_201_CREATED)
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
    snapshot = initial_snapshot(_lesson_content(db, lesson), _lesson_snapshot_meta(lesson))
    snapshot["profile_id"] = profile.id
    record = TrainingSession(profile_id=profile.id, lesson_id=lesson.id, state_version=snapshot["state_version"], snapshot=snapshot)
    db.add(record)
    db.commit()
    return _session_payload(record)


@app.get(f"{API_PREFIX}/training/sessions/{{session_id}}")
def get_session(session_id: str, db: DbSession) -> dict:
    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    return {"session": record.snapshot}


@app.post(f"{API_PREFIX}/training/sessions/{{session_id}}/commands")
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
        return receipt.response

    record = db.get(TrainingSession, session_id)
    if not record:
        raise HTTPException(status_code=404, detail={"code": "SESSION_NOT_FOUND"})
    if request.expected_state_version != record.state_version:
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT", "current_state_version": record.state_version})

    try:
        result = apply_command(record.snapshot, request.model_dump())
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

    for offset, event in enumerate(result.events, start=1):
        db.add(TrainingEvent(session_id=session_id, sequence_no=request.expected_state_version + offset, type=event["type"], payload=event["payload"]))
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
        db.commit()
    except IntegrityError:
        db.rollback()
        raced_receipt = db.scalar(select(CommandReceipt).where(CommandReceipt.session_id == session_id, CommandReceipt.idempotency_key == idempotency_key))
        if raced_receipt and raced_receipt.request_hash == request_hash:
            return raced_receipt.response
        raise HTTPException(status_code=409, detail={"code": "VERSION_CONFLICT"})
    return response
