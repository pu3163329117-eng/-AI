"""Versioned, closed contracts. No model output contains executable commands."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "feedback-v1"
Task = Literal["teacher", "evaluator", "diagnose"]
Text = Annotated[str, Field(strict=True, min_length=1, max_length=2000)]
Identifier = Annotated[str, Field(strict=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")]
UnitScore = Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]
Misconception = Literal[
    "UNKNOWN_LEXICAL_SENSE", "MODERN_MEANING_BIAS", "MISSED_SUBJECT", "MISSED_OBJECT",
    "MISSED_SYNTAX_STRUCTURE", "MISSED_AGENT_RELATION", "IGNORED_LATER_CONTEXT",
    "IGNORED_PASSAGE_THEME", "INVALID_EVIDENCE", "CORRECT_BUT_GUESSING",
    "READING_COMPREHENSION_GAP", "INSUFFICIENT_DATA",
]


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    @field_validator("*")
    @classmethod
    def no_blank_strings(cls, value):
        if isinstance(value, str) and not value.strip():
            raise ValueError("Blank text")
        return value


class Evidence(ClosedModel):
    id: Identifier
    text: Text


class RubricItem(ClosedModel):
    id: Identifier
    criterion: Text


class TeacherInput(ClosedModel):
    stage: Literal["CORE", "TRANSFER"]
    text_version: Annotated[str, Field(strict=True, min_length=1, max_length=200)]
    target: Annotated[str, Field(strict=True, min_length=1, max_length=80)]
    visible_evidence: Annotated[list[Evidence], Field(min_length=1, max_length=12)]
    hint_level: Annotated[int, Field(strict=True, ge=1, le=5)]


class EvaluatorInput(ClosedModel):
    stage: Literal["CORE", "TRANSFER"]
    text_version: Annotated[str, Field(strict=True, min_length=1, max_length=200)]
    target: Annotated[str, Field(strict=True, min_length=1, max_length=80)]
    visible_evidence: Annotated[list[Evidence], Field(min_length=1, max_length=12)]
    student_reason: Text
    student_conclusion: Annotated[str, Field(strict=True, min_length=1, max_length=200)]
    rubric: Annotated[list[RubricItem], Field(min_length=1, max_length=12)]


class DiagnoseInput(ClosedModel):
    observations: Annotated[list[Evidence], Field(min_length=1, max_length=12)]


class TeacherOutput(ClosedModel):
    utterance: Annotated[str, Field(strict=True, min_length=1, max_length=300)] | None
    ui_action: Literal["NONE", "FOCUS_EVIDENCE"]
    focus_span_ids: Annotated[list[Identifier], Field(max_length=12)]
    prohibited_answer_leak: Annotated[bool, Field(strict=True)]

    @model_validator(mode="after")
    def abstention(self):
        if self.prohibited_answer_leak:
            raise ValueError("Reported answer leak")
        if self.utterance is None and (self.ui_action != "NONE" or self.focus_span_ids):
            raise ValueError("Silent abstention cannot focus evidence")
        return self


class EvaluatorOutput(ClosedModel):
    label: Literal["CORRECT_REASONING", "CORRECT_BUT_GUESSING", "PARTIALLY_CORRECT", "WRONG_KNOWLEDGE",
                   "WRONG_CONTEXT", "WRONG_SYNTAX", "WRONG_REASONING", "INSUFFICIENT_EVIDENCE", "UNSCORABLE"]
    score: UnitScore | None
    matched_rubric_items: Annotated[list[Identifier], Field(max_length=12)]
    misconception_codes: Annotated[list[Misconception], Field(max_length=12)]
    evidence_ids: Annotated[list[Identifier], Field(max_length=12)]
    evidence_quality: UnitScore | None
    next_action_recommendation: Literal["REVISIT_EVIDENCE", "RETRY_REASONING", "HUMAN_REVIEW"]
    confidence: UnitScore | None

    @model_validator(mode="after")
    def coherent_score(self):
        if self.label == "UNSCORABLE":
            if self.score is not None or self.evidence_quality is not None or self.matched_rubric_items:
                raise ValueError("Unscorable feedback cannot claim a score or matched rubric")
            if self.next_action_recommendation != "HUMAN_REVIEW":
                raise ValueError("Unscorable feedback requires human review")
        elif self.score is None or self.confidence is None or self.evidence_quality is None or not self.evidence_ids:
            raise ValueError("Scored feedback requires confidence and cited evidence")
        if self.label == "CORRECT_REASONING" and (self.score != 1 or not self.matched_rubric_items):
            raise ValueError("Correct reasoning must cite a matched rubric")
        return self


class DiagnoseOutput(ClosedModel):
    diagnosis_code: Misconception
    confidence: UnitScore | None
    supporting_observation_ids: Annotated[list[Identifier], Field(max_length=12)]
    recommended_hint_skill: Literal["REVISIT_CONTEXT", "IDENTIFY_RELATION", "CHECK_SYNTAX", "HUMAN_REVIEW"]

    @model_validator(mode="after")
    def supported_diagnosis(self):
        if self.diagnosis_code != "INSUFFICIENT_DATA" and (self.confidence is None or not self.supporting_observation_ids):
            raise ValueError("Diagnosis requires cited observations and confidence")
        return self


INPUTS = {"teacher": TeacherInput, "evaluator": EvaluatorInput, "diagnose": DiagnoseInput}
OUTPUTS = {"teacher": TeacherOutput, "evaluator": EvaluatorOutput, "diagnose": DiagnoseOutput}
