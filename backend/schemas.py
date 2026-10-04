from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


CommandType = Literal[
    "SELECT_EVIDENCE", "DEFER_VARIABLE", "REVISIT_VARIABLE", "REQUEST_HINT", "SUBMIT_ATTEMPT", "CONTINUE_TO_TRANSFER", "COMPLETE_SESSION"
]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: CommandType
    expected_state_version: int = Field(ge=1)
    payload: dict[str, Any] = Field(default_factory=dict)
