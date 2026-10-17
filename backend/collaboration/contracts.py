from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ContextItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    layer: Literal["project_baseline", "current_task", "session_summary", "evidence"]
    source_id: str = Field(min_length=1, max_length=160)
    source_version: str = Field(min_length=1, max_length=120)
    classification: Literal["synthetic", "project_non_sensitive"]
    content: str = Field(min_length=1, max_length=32_000)

    @field_validator("source_id")
    @classmethod
    def source_is_an_identifier_not_a_file_request(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        parts = [part.lower() for part in normalized.split("/")]
        if normalized.startswith(("/", "~/")) or ".." in parts or ".env" in parts:
            raise ValueError("source_id must not request a filesystem path")
        if len(value) >= 2 and value[1] == ":":
            raise ValueError("source_id must not request a filesystem path")
        return value


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=8_000)
    acceptance_criteria: list[str] = Field(min_length=1, max_length=30)
    forbidden_actions: list[str] = Field(default_factory=list, max_length=30)
    context_items: list[ContextItemRequest] = Field(min_length=1, max_length=80)
    max_context_bytes: int = Field(default=128_000, ge=1_024, le=512_000)

    @field_validator("acceptance_criteria", "forbidden_actions")
    @classmethod
    def validate_lines(cls, value: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 500 for item in value):
            raise ValueError("items must contain 1-500 visible characters")
        return value


class CreateRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1, max_length=32_000)
    manifest_version: int = Field(ge=1)
    max_output_tokens: int = Field(default=2_048, ge=1, le=16_384)
    timeout_seconds: int = Field(default=120, ge=1, le=900)


class CreateManifestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_current_version: int = Field(ge=1)
    context_items: list[ContextItemRequest] = Field(min_length=1, max_length=80)
    max_context_bytes: int = Field(default=128_000, ge=1_024, le=512_000)


class FollowUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=32_000)
    manifest_version: int = Field(ge=1)
    max_output_tokens: int = Field(default=2_048, ge=1, le=16_384)
    timeout_seconds: int = Field(default=120, ge=1, le=900)
