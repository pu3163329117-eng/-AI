"""Same-transaction persistence and read-only learning-behavior reports."""
from collections import defaultdict
from copy import deepcopy
from datetime import timedelta, timezone
from sqlalchemy import select
from .models import TrainingSession, TrainingEvent
from .observation_models import StageObservation
from .assessment import ensure_profile, utc_iso
try:
    from backend.domain.observations import STAGES, traced, aggregate
except ModuleNotFoundError:
    from domain.observations import STAGES, traced, aggregate

LOCAL_TIMEZONE = timezone(timedelta(hours=8))
ATTEMPT_EVENTS = {"training.attempt_evaluated", "training.answer_validated", "training.transfer_validated"}
VALIDATION_EVENTS = {"training.answer_validated", "training.transfer_validated"}


def local_date(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(LOCAL_TIMEZONE).date().isoformat()


def persist_observations(db, record, result, source_events=None):
    """Do not commit; caller's CAS/events/receipt/points own the atomic transaction."""
    if not traced(result.snapshot):
        return
    sources = list(source_events.values()) if isinstance(source_events, dict) else list(source_events or [])
    for event in result.events:
        if event["type"] != "training.first_attempt_recorded":
            continue
        payload = event["payload"]
        stage = payload["stage"]
        if any(isinstance(row, StageObservation) and row.session_id == record.id and row.stage == stage for row in db.new):
            continue
        existing = db.scalar(select(StageObservation).where(StageObservation.session_id == record.id, StageObservation.stage == stage))
        if existing:
            continue  # Immutable first attempt survives retries and duplicate calls.
        source = next((row for row in sources if row.type == event["type"] and row.payload == payload and row.session_id == record.id), None)
        if source is None or source.id is None or source.created_at is None:
            raise ValueError("OBSERVATION_SOURCE_EVENT_REQUIRED")
        db.add(StageObservation(session_id=record.id, profile_id=record.profile_id, stage=stage,
            source_event_id=source.id, payload=deepcopy(payload), created_at=source.created_at))


def report(db, profile_id):
    ensure_profile(db, profile_id)
    sessions = db.scalars(select(TrainingSession).where(TrainingSession.profile_id == profile_id)).all()
    ids = [session.id for session in sessions]
    observations = db.scalars(select(StageObservation).where(StageObservation.session_id.in_(ids), StageObservation.profile_id == profile_id)).all() if ids else []
    events = db.scalars(select(TrainingEvent).where(TrainingEvent.session_id.in_(ids)).order_by(TrainingEvent.sequence_no)).all() if ids else []
    stage_events = defaultdict(list)
    for event in events:
        stage = event.payload.get("stage") if isinstance(event.payload, dict) else None
        if stage in STAGES:
            stage_events[(event.session_id, stage)].append(event)
    session_map = {session.id: session for session in sessions}
    records = []
    for observation in observations:
        payload = observation.payload
        session = session_map[observation.session_id]
        group = stage_events[(session.id, observation.stage)]
        validations = [event for event in group if event.type in VALIDATION_EVENTS]
        attempts = sum(event.type in ATTEMPT_EVENTS for event in group)
        validation = validations[0] if validations else None
        records.append({"session_id": session.id, "stage": observation.stage, "first_answer": payload["answer"],
            "first_correct": payload["correct"], "first_evidence_rule_matched": payload["evidence_rule_matched"],
            "assistance_status": payload["assistance_status"], "assistance_kinds": payload["assistance_kinds"],
            "attempt_count": max(1, attempts), "validated": bool(validation), "retry_completed": bool(validation) and attempts > 1,
            "reason_review_status": payload["reason_review_status"], "lesson_id": payload["lesson_id"] or session.lesson_id,
            "source": payload["source"], "text_version": payload["text_version"],
            "first_submitted_at": utc_iso(observation.created_at), "validated_at": utc_iso(validation.created_at) if validation else None,
            "first_submitted_date": local_date(observation.created_at), "validated_date": local_date(validation.created_at) if validation else None,
            "_sort_time": utc_iso(observation.created_at)})
    for session in sessions:
        if traced(session.snapshot):
            continue  # New unattempted sessions have no invented first observation.
        observed_stages = {stage for (sid, stage), group in stage_events.items() if sid == session.id and any(event.type in ATTEMPT_EVENTS for event in group)}
        if not observed_stages and session.snapshot.get("stage") in STAGES and (session.snapshot.get("selected_answer") is not None or session.snapshot.get("completed")):
            observed_stages = {session.snapshot["stage"]}
        for stage in sorted(observed_stages):
            group = stage_events[(session.id, stage)]
            validation = next((event for event in group if event.type in VALIDATION_EVENTS), None)
            records.append({"session_id": session.id, "stage": stage, "first_answer": None, "first_correct": None,
                "first_evidence_rule_matched": None, "assistance_status": "UNKNOWN", "assistance_kinds": [],
                "attempt_count": sum(event.type in ATTEMPT_EVENTS for event in group), "validated": bool(validation), "retry_completed": None,
                "reason_review_status": "UNKNOWN", "lesson_id": session.lesson_id or session.snapshot.get("lesson", {}).get("id"),
                "source": None, "text_version": None, "first_submitted_at": None,
                "validated_at": utc_iso(validation.created_at) if validation else None,
                "first_submitted_date": None, "validated_date": None, "_sort_time": utc_iso(session.updated_at)})
    totals, trend = aggregate(records)
    totals.update(new_sessions=sum(traced(session.snapshot) for session in sessions),
                  legacy_sessions=sum(not traced(session.snapshot) for session in sessions))
    ordered = sorted(records, key=lambda record: (record["_sort_time"], record["session_id"], record["stage"]), reverse=True)
    visible = [{key: deepcopy(value) for key, value in record.items() if key not in {"first_submitted_date", "validated_date", "_sort_time"}} for record in ordered[:50]]
    return {"profile_id": profile_id, "schema_version": 1, "scope": "LEARNING_BEHAVIOR", "totals": totals, "trend": trend,
        "records": visible, "explanation": "统计学习模式中的首次词义选择、预设证据覆盖与辅助记录，不是闭卷能力测量；未记录辅助不等于独立作答，理由未经语义审核。分母为有新观测的阶段，旧记录辅助情况未知，不纳入首次比例。最近仅展示 50 条，汇总和趋势使用全部新观测；日期按北京时间，重试通过按真实阶段验证日统计。不修改正式等级、翻译能力或积分。"}
