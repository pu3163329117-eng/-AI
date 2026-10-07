"""Candidate content invariants; no DB startup or simulated human approval."""
from collections import Counter
from urllib.parse import urlsplit

import pytest

from backend.domain.assessment_bank import BANK_VERSION, QUESTION_BANK
from backend.domain.reading_context import reading_context_for


def test_candidate_cells_and_stable_identities():
    assert BANK_VERSION == "assessment-pilot-v2"
    assert len(QUESTION_BANK) == 48
    expected = {(dimension, difficulty): 4 for dimension in ("vocabulary", "syntax", "context", "chapter") for difficulty in ("L1", "L2", "L3")}
    assert Counter((q["dimension"], q["difficulty"]) for q in QUESTION_BANK) == expected
    assert len({q["id"] for q in QUESTION_BANK}) == 48
    option_ids = [option["id"] for q in QUESTION_BANK for option in q["options"]]
    assert len(set(option_ids)) == len(option_ids) == 192
    assert len({q["source"] for q in QUESTION_BANK}) == 13
    assert max(Counter(q["source"] for q in QUESTION_BANK).values()) <= 10


@pytest.mark.parametrize("question", QUESTION_BANK, ids=[q["id"] for q in QUESTION_BANK])
def test_exact_current_corpus_passage_and_choice_contract(question):
    q = question
    assert q["version"] == BANK_VERSION and q["type"] == "choice"
    assert q["review_status"] == "DRAFT"
    assert q["reviewer"] is None and q["reviewed_at"] is None
    assert all(isinstance(q[field], str) and q[field].strip() for field in ("stem", "source", "source_url", "passage", "explanation", "text_version"))
    assert isinstance(q["tags"], list) and q["tags"] and len(set(q["tags"])) == len(q["tags"])
    options = q["options"]
    assert len(options) == len({o["id"] for o in options}) == len({o["text"] for o in options}) == 4
    assert all(o["text"].strip() and o["id"].startswith(q["id"] + "-option-") for o in options)
    assert q["answer_id"] in {o["id"] for o in options}
    context = reading_context_for({"source": q["source"], "passage": ""})
    assert context["extent"] != "PROMPT"
    assert q["text_version"] == context["text_version"]
    assert q["source_url"] == context["source_url"]
    url = urlsplit(q["source_url"])
    assert url.scheme == "https" and url.hostname in ("zh.wikisource.org", "en.wikisource.org")
    assert not url.username and not url.password
    assert q["material_extent"] == context["extent"]
    assert context["full_text"][q["full_text_start"]:q["full_text_end"]] == q["passage"]
    if q["paragraph_index"] is not None:
        assert context["paragraphs"][q["paragraph_index"]][q["start"]:q["end"]] == q["passage"]
    else:
        assert q["start"] is None and q["end"] is None
    if q["dimension"] == "chapter":
        assert q["passage"] == context["full_text"]
        assert q["passage_extent"] in ("FULL", "CHAPTER")
        assert context["extent"] in ("FULL", "CHAPTER")


def test_answers_are_not_encoded_as_presentation_letters_or_all_first():
    distribution = Counter(next(i for i, option in enumerate(q["options"]) if option["id"] == q["answer_id"]) for q in QUESTION_BANK)
    assert distribution == {0: 12, 1: 12, 2: 12, 3: 12}
    assert all(q["answer_id"] not in ("A", "B", "C", "D") for q in QUESTION_BANK)


def test_chapter_questions_never_promote_xunzi_or_history_excerpt_to_full():
    assert not any(q["dimension"] == "chapter" and q["source"] in ("《劝学》", "《宋史·范仲淹传》") for q in QUESTION_BANK)
    assert all(q["material_extent"] == "EXCERPT" for q in QUESTION_BANK if q["source"] == "《劝学》")
