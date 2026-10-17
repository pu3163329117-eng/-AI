"""Opinions are operator-entered drafts; no output changes any release gate."""
from typing import Annotated, Literal

from pydantic import Field, field_validator

from .contracts import ClosedModel, EvaluatorOutput

Label = EvaluatorOutput.model_fields["label"].annotation
Hash = Annotated[str, Field(strict=True, pattern=r"^[0-9a-f]{64}$")]


class ReviewFields(ClosedModel):
    reviewer: Annotated[str, Field(strict=True, min_length=1, max_length=80)]
    decision: Literal["ACCEPTABLE", "NEEDS_REVISION", "UNCERTAIN"]
    context_sufficiency: Literal["SUFFICIENT", "INSUFFICIENT", "UNCERTAIN"]
    source_basis: Annotated[str, Field(strict=True, min_length=1, max_length=2000)]
    rationale: Annotated[str, Field(strict=True, min_length=1, max_length=4000)]
    alternatives: Annotated[str, Field(strict=True, min_length=1, max_length=4000)] | None
    suggested_labels: Annotated[list[Label], Field(max_length=9)]

    @field_validator("reviewer", "source_basis", "rationale", "alternatives", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("suggested_labels")
    @classmethod
    def unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("Unique labels required")
        return value


class ReviewRequest(ClosedModel):
    expected_suite_digest: Hash
    expected_input_digest: Hash
    expected_revision: Annotated[int, Field(strict=True, ge=0, le=100)]
    fields: ReviewFields

