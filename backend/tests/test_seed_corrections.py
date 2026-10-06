"""Corrections upgrade only untouched seed data, never authored/historical work."""
from __future__ import annotations

from copy import deepcopy
import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from backend.db.models import Lesson, LessonContent, TrainingSession
from backend.db.seed import LEGACY_CONTENT_FIXES, LEGACY_SEED_METADATA, SEEDS, apply_seed_corrections, seed_lessons
from backend.db.session import Base
from backend.domain.training import apply_command, initial_snapshot
from backend.domain.editorial import review_readiness
from backend.domain.reading_context import reading_context_for
from backend.main import _lesson_snapshot_meta


@pytest.fixture
def legacy_catalogue():
    # No shared test DB, user DB, or existing editorial rows are touched.
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        seed_lessons(db)
        for (lesson_id, stage), legacy in LEGACY_CONTENT_FIXES.items():
            lesson = db.get(Lesson, lesson_id)
            for key, value in LEGACY_SEED_METADATA[lesson_id].items():
                setattr(lesson, key, deepcopy(value))
            row = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson_id, LessonContent.stage == stage))
            row.payload = deepcopy(legacy)
        db.commit()
        yield db
    engine.dispose()


def _payloads(db: Session) -> dict:
    return {(row.lesson_id, row.stage): deepcopy(row.payload) for row in db.scalars(select(LessonContent))}


def test_three_exact_legacy_payloads_are_corrected_once_without_changing_other_content(legacy_catalogue):
    db = legacy_catalogue
    before = _payloads(db)
    assert len(LEGACY_CONTENT_FIXES) == 3
    apply_seed_corrections(db)
    db.commit()
    after = _payloads(db)
    changed = {key for key in before if before[key] != after[key]}
    assert changed == set(LEGACY_CONTENT_FIXES)
    zuo = after[("lesson-junior-zuo-01", "TRANSFER")]
    assert zuo["source"] == "《晏子春秋·内篇杂下》"
    assert zuo["correct_answer"] == "犯罪"
    jia = after[("lesson-senior-jia-01", "TRANSFER")]
    assert jia["passage"] == "录毕，走送之，不敢稍逾约。以是人多以书假余，余因得遍观群书。"
    assert "余故道" not in jia["passage"]
    gui = after[("lesson-senior-gui-01", "TRANSFER")]
    assert gui["correct_answer"] == "赞许、认可"
    assert "朱熹" in gui["validated_feedback"]
    for seed in SEEDS:
        if seed["id"] not in {key[0] for key in LEGACY_CONTENT_FIXES}:
            continue
        lesson = db.get(Lesson, seed["id"])
        for key, value in seed.items():
            if key != "contents":
                assert getattr(lesson, key) == value
    apply_seed_corrections(db)
    db.commit()
    assert _payloads(db) == after


@pytest.mark.parametrize("kind", ["payload", "metadata", "draft"])
def test_authored_variants_and_unpublished_work_are_never_overwritten(legacy_catalogue, kind):
    db = legacy_catalogue
    lesson_id = "lesson-junior-zuo-01"
    row = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson_id, LessonContent.stage == "TRANSFER"))
    lesson = db.get(Lesson, lesson_id)
    if kind == "payload":
        row.payload = {**row.payload, "question": "教研老师修改后的问题"}
    elif kind == "metadata":
        lesson.title = "教研老师自行编排的坐字课"
    else:
        lesson.status = "DRAFT"
    db.commit()
    authored = deepcopy(row.payload)
    metadata = {key: deepcopy(getattr(lesson, key)) for key in LEGACY_SEED_METADATA[lesson_id]}
    apply_seed_corrections(db)
    db.commit()
    assert row.payload == authored
    assert {key: getattr(lesson, key) for key in metadata} == metadata
    assert lesson.status == ("DRAFT" if kind == "draft" else "PUBLISHED")


def test_existing_training_snapshot_keeps_the_original_edition_and_answer(legacy_catalogue):
    db = legacy_catalogue
    lesson_id = "lesson-junior-zuo-01"
    contents = {row.stage: row.payload for row in db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson_id))}
    core = {**contents["CORE"], "transfer": contents["TRANSFER"]}
    frozen = initial_snapshot(core)
    session = TrainingSession(lesson_id=lesson_id, state_version=frozen["state_version"], snapshot=deepcopy(frozen))
    db.add(session)
    db.commit()
    session_id = session.id
    apply_seed_corrections(db)
    db.commit()
    db.expire_all()
    assert db.get(TrainingSession, session_id).snapshot == frozen
    selected = apply_command(frozen, {"type": "SELECT_EVIDENCE"}).snapshot
    validated = apply_command(selected, {"type": "SUBMIT_ATTEMPT", "payload": {"answer": selected["correct_answer"]}}).snapshot
    historical_transfer = apply_command(validated, {"type": "CONTINUE_TO_TRANSFER"}).snapshot
    assert historical_transfer["source"] == "《唐雎不辱使命》"
    assert historical_transfer["correct_answer"] == "因为"
    assert _payloads(db)[(lesson_id, "TRANSFER")]["correct_answer"] == "犯罪"


def test_all_sixteen_seed_stages_have_thirteen_ready_source_units_without_fake_human_reviews():
    sources = set()
    stages = 0
    for seed in SEEDS:
        assert review_readiness(seed["contents"]) == [], seed["id"]
        for payload in seed["contents"].values():
            stages += 1
            sources.add(payload["source"])
            context = reading_context_for(payload)
            assert context["source_url"].startswith("https://")
            assert context["text_version"] and "待" not in context["text_version"]
            assert "reviewer" not in context and "reviewed_at" not in context
    assert stages == 16
    assert len(sources) == 13


def test_corrected_seed_snapshot_has_content_version_but_no_fabricated_reviewer(legacy_catalogue):
    db = legacy_catalogue
    apply_seed_corrections(db)
    lesson = db.get(Lesson, "lesson-junior-zuo-01")
    content = {row.stage: {**row.payload, "reading_context": reading_context_for(row.payload)}
               for row in db.scalars(select(LessonContent).where(LessonContent.lesson_id == lesson.id))}
    meta = _lesson_snapshot_meta(db, lesson, content)
    snapshot = initial_snapshot({**content["CORE"], "transfer": content["TRANSFER"]}, meta)
    assert snapshot["lesson"]["review_status"] == "UNREVIEWED"
    assert len(snapshot["lesson"]["content_version"]) == 12
    assert snapshot["lesson"]["reviewer"] is None
    assert snapshot["lesson"]["reviewed_at"] is None
