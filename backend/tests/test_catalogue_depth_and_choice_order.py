from __future__ import annotations

import copy
import os
from pathlib import Path

os.environ["WENYAN_DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test-wenyan.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from backend.db.seed import JUNIOR_CORE  # noqa: E402
from backend.domain.training import initial_snapshot  # noqa: E402
from backend.main import app  # noqa: E402


EXPECTED_SEED_IDS = {
    "JUNIOR": {
        "lesson-junior-cong-01",
        "lesson-junior-qu-01",
        "lesson-junior-shu-01",
        "lesson-junior-zuo-01",
    },
    "SENIOR": {
        "lesson-senior-gui-01",
        "lesson-senior-qiong-01",
        "lesson-senior-jia-01",
        "lesson-senior-yi-01",
    },
}


def _profile(client: TestClient, school_stage: str) -> str:
    response = client.post(
        "/api/v1/profiles",
        json={"display_name": f"{school_stage} catalogue QA", "school_stage": school_stage},
    )
    assert response.status_code == 201
    return response.json()["profile"]["id"]


def test_each_stage_has_a_richer_public_catalogue_and_every_lesson_starts():
    """All learner-visible lessons must have complete, session-ready two-stage content."""
    with TestClient(app) as client:
        for school_stage in ("JUNIOR", "SENIOR"):
            catalogue = client.get("/api/v1/lessons", params={"school_stage": school_stage})
            assert catalogue.status_code == 200
            lessons = catalogue.json()["lessons"]

            # "Richer" should mean more than the former single lesson per stage,
            # and should expose varied reading material rather than one source copied.
            assert EXPECTED_SEED_IDS[school_stage] <= {lesson["id"] for lesson in lessons}
            assert len(lessons) >= 3
            assert len({lesson["source"] for lesson in lessons}) >= 3
            assert len({lesson["title"] for lesson in lessons}) >= 3

            profile_id = _profile(client, school_stage)
            for lesson in lessons:
                assert lesson["summary"].strip()
                assert lesson["estimated_minutes"] > 0

                started = client.post(
                    "/api/v1/training/sessions",
                    json={"profile_id": profile_id, "lesson_id": lesson["id"]},
                )
                assert started.status_code == 201, started.json()
                session = started.json()["session"]
                transfer = session["transfer_content"]

                assert session["lesson"]["id"] == lesson["id"]
                assert session["stage"] == "CORE"
                assert session["question"].strip() and session["passage"].strip()
                # Older editorial drafts can remain valid two-choice records, but
                # the expanded curated catalogue establishes the richer three-choice
                # learning standard for all newly supplied lessons.
                minimum_choices = 3 if lesson["id"] in EXPECTED_SEED_IDS[school_stage] else 2
                assert len(session["choices"]) >= minimum_choices
                assert session["correct_answer"] in session["choices"]
                assert transfer["question"].strip() and transfer["passage"].strip()
                assert len(transfer["choices"]) >= minimum_choices
                assert transfer["correct_answer"] in transfer["choices"]


class _RotatingSampler:
    """A deterministic stand-in for secure choice sampling, avoiding flaky RNG tests."""

    def __init__(self) -> None:
        self.calls = 0

    def sample(self, population: list[str], k: int) -> list[str]:
        assert k == len(population)
        self.calls += 1
        offset = self.calls % len(population)
        return [*population[offset:], *population[:offset]]


def test_session_choice_sampling_preserves_answers_and_changes_answer_slot_deterministically():
    """Choice shuffling must never change authored content or make A the permanent answer."""
    authored = copy.deepcopy(JUNIOR_CORE)
    authored["transfer"] = copy.deepcopy(JUNIOR_CORE)
    authored["transfer"].update(
        source="迁移材料",
        passage="迁移句。",
        question="迁移题？",
        evidence="迁移证据",
        validated_feedback="迁移反馈。",
    )
    sampler = _RotatingSampler()

    first = initial_snapshot(authored, randomizer=sampler)
    second = initial_snapshot(authored, randomizer=sampler)

    # Both stages are independently shuffled, retain every authored option, and
    # always accept the original correct-answer value.
    for snapshot in (first, second):
        assert sorted(snapshot["choices"]) == sorted(authored["choices"])
        assert snapshot["correct_answer"] in snapshot["choices"]
        transfer = snapshot["transfer_content"]
        assert sorted(transfer["choices"]) == sorted(authored["transfer"]["choices"])
        assert transfer["correct_answer"] in transfer["choices"]

    # The fake sampler forces two known permutations, proving the correct answer
    # is not attached to a permanent letter without relying on probabilistic runs.
    correct_positions = {first["choices"].index(first["correct_answer"]), second["choices"].index(second["correct_answer"])}
    assert len(correct_positions) == 2
    assert authored["choices"] == JUNIOR_CORE["choices"]
