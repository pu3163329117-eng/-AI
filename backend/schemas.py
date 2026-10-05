from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


CommandType = Literal[
    "SELECT_EVIDENCE", "DEFER_VARIABLE", "REVISIT_VARIABLE", "REQUEST_HINT", "SUBMIT_ATTEMPT", "CONTINUE_TO_TRANSFER", "COMPLETE_SESSION"
]
SchoolStage = Literal["JUNIOR", "SENIOR"]


class CreateProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=20)
    school_stage: SchoolStage


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str = Field(min_length=1, max_length=36)
    lesson_id: str | None = Field(default=None, min_length=1, max_length=36)


class LessonContentRequest(BaseModel):
    """Editorial payload for one complete learner-facing lesson."""

    model_config = ConfigDict(extra="forbid")
    CORE: dict[str, Any]
    TRANSFER: dict[str, Any]


class CreateAdminLessonRequest(BaseModel):
    """A new lesson always begins as a draft; publishing is an explicit action."""

    model_config = ConfigDict(extra="forbid")
    # A human editor should not have to invent an ASCII identifier for a
    # Chinese lesson title. When omitted, the service generates a draft slug.
    slug: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    school_stage: SchoolStage
    title: str = Field(min_length=1, max_length=120)
    source: str = Field(min_length=1, max_length=120)
    difficulty: str = Field(min_length=1, max_length=30)
    estimated_minutes: int = Field(ge=1, le=180)
    summary: str = Field(min_length=1, max_length=300)
    level_order: int = Field(default=100, ge=1, le=10000)
    textbook_tags: list[str] = Field(min_length=1, max_length=12)
    theme: str = Field(min_length=1, max_length=120)
    accumulation_points: list[str] = Field(min_length=1, max_length=20)
    reasoning_points: list[str] = Field(min_length=1, max_length=20)
    reasoning_level: str = Field(min_length=1, max_length=80)
    content: LessonContentRequest | None = None


class UpdateAdminLessonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    school_stage: SchoolStage | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)
    source: str | None = Field(default=None, min_length=1, max_length=120)
    difficulty: str | None = Field(default=None, min_length=1, max_length=30)
    estimated_minutes: int | None = Field(default=None, ge=1, le=180)
    summary: str | None = Field(default=None, min_length=1, max_length=300)
    level_order: int | None = Field(default=None, ge=1, le=10000)
    textbook_tags: list[str] | None = Field(default=None, min_length=1, max_length=12)
    theme: str | None = Field(default=None, min_length=1, max_length=120)
    accumulation_points: list[str] | None = Field(default=None, min_length=1, max_length=20)
    reasoning_points: list[str] | None = Field(default=None, min_length=1, max_length=20)
    reasoning_level: str | None = Field(default=None, min_length=1, max_length=80)
    content: LessonContentRequest | None = None


class CommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: CommandType
    expected_state_version: int = Field(ge=1)
    payload: dict[str, Any] = Field(default_factory=dict)
