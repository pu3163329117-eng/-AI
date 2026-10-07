"""Codepoint-based corpus identity and exact annotation positioning."""
from __future__ import annotations

import hashlib
import json
import unicodedata


def corpus_hash(source: str, context: dict) -> str:
    data = json.dumps({"source": source, "context": context}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def sentence_for(paragraph: str, start: int, end: int) -> str:
    """Keep semicolons inside sentences and include final punctuation."""
    left = 0
    for index in range(start):
        if paragraph[index] in "。！？!?":
            left = index + 1
    right = len(paragraph)
    for index in range(max(start, end - 1), len(paragraph)):
        if paragraph[index] in "。！？!?":
            right = index + 1
            break
    return paragraph[left:right]


def selection_for(context: dict, paragraph_index: int, start: int, end: int) -> dict:
    paragraphs = context.get("paragraphs")
    if any(type(number) is not int for number in (paragraph_index, start, end)) or not isinstance(paragraphs, list) or not 0 <= paragraph_index < len(paragraphs):
        raise ValueError("INVALID_KNOWLEDGE_SELECTION")
    paragraph = paragraphs[paragraph_index]
    if not isinstance(paragraph, str) or not 0 <= start < end <= len(paragraph) or end - start > 80:
        raise ValueError("INVALID_KNOWLEDGE_SELECTION")
    token = paragraph[start:end]
    if not any(unicodedata.category(c)[0] in "LN" for c in token):
        raise ValueError("INVALID_KNOWLEDGE_SELECTION")
    return {"token": token, "paragraph_index": paragraph_index, "start": start, "end": end, "sentence": sentence_for(paragraph, start, end)}


def _find_nth(text: str, token: str, occurrence: int) -> int:
    if type(occurrence) is not int or occurrence < 0:
        raise ValueError("annotation occurrence must be a non-negative integer")
    start = -1
    for _ in range(occurrence + 1):
        start = text.find(token, start + 1)
        if start < 0:
            raise ValueError(f"annotation anchor/token not found: {token!r}")
    return start


def locate_annotation(context: dict, annotation: dict) -> dict:
    for field in ("source", "anchor", "token", "sense_key", "meaning", "part_of_speech", "reasoning"):
        if not isinstance(annotation.get(field), str) or not annotation[field].strip():
            raise ValueError(f"annotation missing non-empty {field}")
    if annotation.get("variability") not in ("CONTEXTUAL", "STABLE"):
        raise ValueError("annotation variability must be CONTEXTUAL or STABLE")
    paragraph_index = annotation.get("paragraph_index")
    paragraphs = context["paragraphs"]
    if type(paragraph_index) is not int or not 0 <= paragraph_index < len(paragraphs):
        raise ValueError("annotation paragraph_index out of range")
    paragraph = paragraphs[paragraph_index]
    anchor_start = _find_nth(paragraph, annotation["anchor"], annotation.get("anchor_occurrence", 0))
    token_start = _find_nth(annotation["anchor"], annotation["token"], annotation.get("token_occurrence", 0))
    start = anchor_start + token_start
    selected = selection_for(context, paragraph_index, start, start + len(annotation["token"]))
    return {**annotation, **selected}
