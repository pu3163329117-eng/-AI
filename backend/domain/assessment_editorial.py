"""Editorial validation only; supplied signatures are not authenticated identities."""
from copy import deepcopy

from .assessment import valid_question
from .reading_context import reading_context_for

SOURCE_FIELDS = ("source", "source_url", "passage", "text_version", "material_extent",
                 "passage_extent", "paragraph_index", "start", "end", "full_text_start", "full_text_end")
DISCLAIMER = "署名为人工输入，不代表身份认证；审核通过只表示内容审核，评分阈值仍待真实试测校准。"


def validate(question, previous=None):
    if not valid_question(question):
        raise ValueError("ASSESSMENT_QUESTION_INVALID")
    if len(question["options"]) > 8 or len({o["text"].strip() for o in question["options"]}) != len(question["options"]):
        raise ValueError("ASSESSMENT_QUESTION_INVALID")
    tags = question.get("tags")
    if not isinstance(tags, list) or len(set(tags)) != len(tags):
        raise ValueError("ASSESSMENT_QUESTION_INVALID")
    if previous and any(question.get(field) != previous.get(field) for field in SOURCE_FIELDS):
        raise ValueError("ASSESSMENT_QUESTION_SOURCE_FROZEN")
    context = reading_context_for({"source": question["source"], "passage": ""})
    if context["extent"] == "PROMPT" or any(question.get(field) != context[field] for field in ("source_url", "text_version")):
        raise ValueError("ASSESSMENT_QUESTION_SOURCE_INVALID")
    if question.get("material_extent") != context["extent"]:
        raise ValueError("ASSESSMENT_QUESTION_SOURCE_INVALID")
    start, end = question.get("full_text_start"), question.get("full_text_end")
    if not all(type(v) is int for v in (start, end)) or not 0 <= start < end <= len(context["full_text"]):
        raise ValueError("ASSESSMENT_QUESTION_SPAN_INVALID")
    if context["full_text"][start:end] != question["passage"]:
        raise ValueError("ASSESSMENT_QUESTION_SPAN_INVALID")
    index, local_start, local_end = (question.get(k) for k in ("paragraph_index", "start", "end"))
    if index is None:
        if local_start is not None or local_end is not None:
            raise ValueError("ASSESSMENT_QUESTION_SPAN_INVALID")
    elif (type(index) is not int or not 0 <= index < len(context["paragraphs"])
          or not all(type(v) is int for v in (local_start, local_end))
          or not 0 <= local_start < local_end <= len(context["paragraphs"][index])
          or context["paragraphs"][index][local_start:local_end] != question["passage"]):
        raise ValueError("ASSESSMENT_QUESTION_SPAN_INVALID")
    extent = context["extent"] if question["passage"] == context["full_text"] else "EXCERPT"
    if question.get("passage_extent") != extent:
        raise ValueError("ASSESSMENT_QUESTION_SOURCE_INVALID")
    if question["dimension"] == "chapter" and (extent not in ("FULL", "CHAPTER") or question["passage"] != context["full_text"]):
        raise ValueError("ASSESSMENT_QUESTION_CHAPTER_INCOMPLETE")


def edit(previous, fields, revision_version):
    question = {**deepcopy(fields), "id": previous["id"], "version": revision_version,
                "review_status": "DRAFT", "reviewer": None, "reviewed_at": None}
    validate(question, previous)
    return question


def review(previous, decision, actor, timestamp, revision_version):
    # A discovered bad/obsolete source must still be rejectable. Only approval
    # attests that the current complete item passed structural/source checks.
    if decision == "APPROVE":
        validate(previous)
    question = deepcopy(previous)
    question.update(version=revision_version, review_status="APPROVED" if decision == "APPROVE" else "REJECTED",
                    reviewer=actor, reviewed_at=timestamp)
    return question
