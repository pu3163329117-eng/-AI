from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from random import SystemRandom
from typing import Any
from unicodedata import category

from .reading_context import reading_context_for


DEFAULT_LESSON_CONTENT: dict[str, Any] = {
    "source": "《宋史·范仲淹传》",
    "passage": "学者多从质问，为执经讲解，亡所倦。",
    "variable": "从",
    "question": "“从”在这里是什么意思？",
    "choices": ["来自", "跟从求教", "听从命令"],
    "evidence": "为执经讲解",
    "correct_answer": "跟从求教",
    "hints": ["注意“从”前后分别是谁。", "看看后半句：是谁为谁讲解经书？", "“为执经讲解”说明范仲淹正在给求学者讲解。", "在“来自、跟从求教、听从命令”中，哪个更符合求学关系？"],
    "validated_feedback": "判断成立：后文的“讲解”说明学者是求学者，因此“从”是跟从求教。",
    "transfer": {
        "source": "《论语·述而》",
        "passage": "三人行，必有我师焉；择其善者而从之。",
        "variable": "从",
        "question": "“从”在这里是什么意思？",
        "choices": ["跟随、学习", "隐藏起来", "听从命令"],
        "evidence": "择其善者",
        "correct_answer": "跟随、学习",
        "hints": ["先看“从”前面的“善者”指什么。", "“择”表示选择；选择别人的优点之后会做什么？", "“从之”里的“之”指代前面的“善者”。", "在“跟随、学习、隐藏起来、听从命令”中，哪个更符合“择其善者”？"],
        "validated_feedback": "迁移成功：先看“择其善者”，就能判断“从之”是跟随其优点去学习。",
    },
    "summary": {"accumulation": "“从”在求学语境中可表示跟随、学习。", "reasoning": "先找人物关系和行为线索，再回到目标词判断。", "earned_points": 20},
}


@dataclass(frozen=True)
class TransitionResult:
    state: str
    snapshot: dict[str, Any]
    events: list[dict[str, Any]]


def _presentation(content: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": content["source"], "passage": content["passage"], "variable": content["variable"], "question": content["question"],
        "choices": content["choices"], "evidence": content["evidence"], "correct_answer": content["correct_answer"],
        "hint_ladder": content["hints"], "validated_feedback": content["validated_feedback"],
        "reading_context": reading_context_for(content),
    }


def _frozen_content_with_shuffled_choices(
    content: dict[str, Any],
    randomizer: Any | None = None,
) -> dict[str, Any]:
    """Copy editorial content and give this session its own answer ordering.

    ``SystemRandom`` draws from the operating system's secure random source.  An
    optional sampler is accepted only to make domain tests deterministic; it must
    provide the same ``sample(population, k)`` method as ``random.SystemRandom``.
    """
    frozen_content = deepcopy(content)
    frozen_content["reading_context"] = reading_context_for(frozen_content)
    sampler = randomizer if randomizer is not None else SystemRandom()
    frozen_content["choices"] = sampler.sample(
        frozen_content["choices"],
        k=len(frozen_content["choices"]),
    )
    return frozen_content


def initial_snapshot(
    content: dict[str, Any] | None = None,
    lesson: dict[str, Any] | None = None,
    randomizer: Any | None = None,
) -> dict[str, Any]:
    """Freeze a selected lesson into the session; editorial changes never rewrite work in progress."""
    content = content or DEFAULT_LESSON_CONTENT
    core_content = _frozen_content_with_shuffled_choices(content, randomizer)
    transfer_content = _frozen_content_with_shuffled_choices(content["transfer"], randomizer)
    snapshot = {
        "stage": "CORE", "state": "AWAITING_INITIAL_ATTEMPT", "state_version": 1, **_presentation(core_content),
        "selected_answer": None, "evidence_selected": False, "deferred": False, "hint_level": 0, "hint": None,
        "context_selection": None,
        "feedback": f"先读完整句话，再判断“{core_content['variable']}”的意思。", "transfer_ready": False,
        "summary_ready": False, "summary": None, "completed": False, "transfer_content": transfer_content,
        "lesson_summary": deepcopy(content.get("summary", DEFAULT_LESSON_CONTENT["summary"])),
    }
    if lesson:
        snapshot["lesson"] = lesson
    return snapshot


def _hint(snapshot: dict[str, Any], level: int) -> str:
    hints = snapshot["hint_ladder"]
    return hints[min(level, len(hints)) - 1]


def _evidence_rule_matches(expected: str, selected: str) -> bool:
    """A curriculum label may enumerate non-adjacent clues with 、.

    This is coverage matching, never semantic assessment of a student's reason.
    Require every listed fragment in the same selected span, not just one word.
    """
    normalize = lambda value: "".join(char for char in value if category(char)[0] in "LN")
    fragments = [normalize(part) for part in expected.split("、")]
    actual = normalize(selected)
    return bool(fragments) and all(fragment and fragment in actual for fragment in fragments)


def _context_selection(snapshot: dict[str, Any], payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve codepoint offsets against this session's frozen reading text."""
    scope = payload.get("scope")
    if scope not in ("WORD", "SENTENCE", "PARAGRAPH", "WORK", "ERA"):
        raise ValueError("INVALID_CONTEXT_SCOPE")
    paragraph_index, start, end = (payload.get(key) for key in ("paragraph_index", "start", "end"))
    if any(type(value) is not int for value in (paragraph_index, start, end)):
        raise ValueError("INVALID_CONTEXT_SELECTION")
    context = snapshot.get("reading_context")
    if context is None:
        # Legacy sessions freeze their own snapshot content, never the live lesson.
        context = reading_context_for(snapshot)
    paragraphs = context.get("paragraphs") if isinstance(context, dict) else None
    if not isinstance(paragraphs, list) or not 0 <= paragraph_index < len(paragraphs):
        raise ValueError("INVALID_CONTEXT_SELECTION")
    paragraph = paragraphs[paragraph_index]
    if not isinstance(paragraph, str) or not 0 <= start < end <= len(paragraph) or end - start > 80:
        raise ValueError("INVALID_CONTEXT_SELECTION")
    token = paragraph[start:end]
    if not any(not char.isspace() and not category(char).startswith("P") for char in token):
        raise ValueError("INVALID_CONTEXT_SELECTION")
    sentence_start = start
    while sentence_start > 0 and paragraph[sentence_start - 1] not in "。！？":
        sentence_start -= 1
    sentence_end = end
    if paragraph[end - 1] not in "。！？":
        while sentence_end < len(paragraph):
            char = paragraph[sentence_end]
            sentence_end += 1
            if char in "。！？":
                break
    return context, {
        "paragraph_index": paragraph_index, "start": start, "end": end,
        "token": token, "sentence": paragraph[sentence_start:sentence_end],
        "paragraph": paragraph, "scope": scope,
    }


def apply_command(snapshot: dict[str, Any], command: dict[str, Any]) -> TransitionResult:
    """Apply one user intent. This layer deliberately has no HTTP or database imports."""
    action, payload = command["type"], command.get("payload", {})
    next_snapshot, events = dict(snapshot), []
    if snapshot["completed"]:
        raise ValueError("SESSION_COMPLETED")

    if action == "SAVE_REASONING":
        if snapshot["transfer_ready"] or snapshot["summary_ready"]:
            raise ValueError("REASONING_STAGE_VALIDATED")
        _, evidence_span = _context_selection(snapshot, {**payload, "scope": "SENTENCE"})
        reason, conclusion = payload.get("reason"), payload.get("conclusion")
        if not isinstance(reason, str) or not 5 <= len(reason.strip()) <= 2000:
            raise ValueError("INVALID_REASONING_REASON")
        if conclusion not in snapshot["choices"]:
            raise ValueError("INVALID_ANSWER")
        matches = _evidence_rule_matches(snapshot["evidence"], evidence_span["token"])
        graph = {
            "schema_version": 1, "stage": snapshot["stage"], "source": snapshot["source"],
            "text_version": snapshot.get("reading_context", {}).get("text_version", "历史快照"),
            "target": snapshot["variable"], "evidence": evidence_span,
            "reason": reason.strip(), "conclusion": conclusion,
            "evidence_rule_matched": matches, "reason_review_status": "UNREVIEWED",
        }
        next_snapshot.update(reasoning_graph=graph, evidence_selected=matches,
                             feedback="已保存证据链；理由尚未人工审核。" + ("可提交词义判断。" if matches else "所选原文未覆盖课程预设线索，可修改证据或继续提交判断。"))
        events.append({"type": "training.reasoning_saved", "payload": graph})
    elif action == "SELECT_EVIDENCE":
        if snapshot.get("reasoning_graph"):
            raise ValueError("REASONING_RECORD_REQUIRED")
        next_snapshot["evidence_selected"] = True
        next_snapshot["feedback"] = "已记录证据。现在用它解释你的判断。"
        events.append({"type": "training.evidence_selected", "payload": {"evidence": snapshot["evidence"], "stage": snapshot["stage"]}})
    elif action == "DEFER_VARIABLE":
        next_snapshot.update(deferred=True, state="VARIABLE_DEFERRED", feedback=f"已暂放“{snapshot['variable']}”。继续读到新证据后，再回来看它。")
        events.append({"type": "training.variable_deferred", "payload": {"variable": snapshot["variable"]}})
    elif action == "REVISIT_VARIABLE":
        if not snapshot["deferred"]:
            raise ValueError("VARIABLE_NOT_DEFERRED")
        next_snapshot.update(deferred=False, state="VARIABLE_REVISITED", feedback=f"回到“{snapshot['variable']}”：结合已读语境和“{snapshot['evidence']}”，重新检查你的判断。")
        events.append({"type": "training.variable_revisited", "payload": {"variable": snapshot["variable"]}})
    elif action == "REQUEST_MORE_CONTEXT":
        context, selection = _context_selection(snapshot, payload)
        next_snapshot.update(reading_context=context, context_selection=selection)
        if snapshot["deferred"]:
            next_snapshot["feedback"] = f"已展开“{selection['token']}”的语境。继续寻找线索，准备好后再回看“{snapshot['variable']}”。"
        events.append({"type": "training.context_expanded", "payload": {
            "stage": snapshot["stage"], "scope": selection["scope"],
            "paragraph_index": selection["paragraph_index"], "start": selection["start"],
            "end": selection["end"], "token": selection["token"],
        }})
    elif action == "REQUEST_HINT":
        level = min(snapshot["hint_level"] + 1, len(snapshot["hint_ladder"]))
        next_snapshot.update(hint_level=level, hint=_hint(snapshot, level), state="HINT_PRESENTED", feedback="提示只增加一条必要信息；答案仍要由你自己作出。")
        events.append({"type": "training.hint_presented", "payload": {"level": level, "stage": snapshot["stage"]}})
    elif action == "SUBMIT_ATTEMPT":
        answer = payload.get("answer")
        if answer not in snapshot["choices"]:
            raise ValueError("INVALID_ANSWER")
        next_snapshot["selected_answer"] = answer
        graph = snapshot.get("reasoning_graph")
        evidence_ready = snapshot["evidence_selected"] and (not graph or graph["conclusion"] == answer)
        if answer == snapshot["correct_answer"] and evidence_ready:
            if snapshot["stage"] == "CORE":
                next_snapshot.update(state="ANSWER_VALIDATED", transfer_ready=True)
                events.append({"type": "training.answer_validated", "payload": {"label": "CORRECT_REASONING", "variable": snapshot["variable"], "stage": snapshot["stage"]}})
            else:
                next_snapshot.update(state="TRANSFER_VALIDATED", summary_ready=True)
                events.append({"type": "training.transfer_validated", "payload": {"label": "TRANSFER_CONFIRMED", "variable": snapshot["variable"], "stage": snapshot["stage"]}})
            next_snapshot["feedback"] = snapshot["validated_feedback"]
            if graph:
                next_snapshot["feedback"] += "（词义与预设证据通过规则核验；你的理由尚未人工审核。）"
        elif answer == snapshot["correct_answer"]:
            next_snapshot.update(state="AWAITING_REASONING" if snapshot["stage"] == "CORE" else "AWAITING_TRANSFER_REASONING", feedback="答案正确。请再选一句证据，说明你为什么这样判断。")
            events.append({"type": "training.attempt_evaluated", "payload": {"label": "CORRECT_BUT_GUESSING", "variable": snapshot["variable"], "stage": snapshot["stage"]}})
        else:
            next_snapshot.update(state="AWAITING_INITIAL_ATTEMPT" if snapshot["stage"] == "CORE" else "AWAITING_TRANSFER_ATTEMPT", feedback=f"这条解释暂时无法和“{snapshot['evidence']}”形成关系。试着使用证据，或请求一条提示。")
            # Keep the minimal attempt context on the immutable event. A session
            # snapshot can later move on to TRANSFER, so the event itself must say
            # which word and stage the learner was working on when the mistake was
            # made. This gives review projections a stable, queryable key.
            events.append(
                {
                    "type": "training.attempt_evaluated",
                    "payload": {
                        "label": "WRONG_CONTEXT",
                        "answer": answer,
                        "variable": snapshot["variable"],
                        "stage": snapshot["stage"],
                    },
                }
            )
    elif action == "CONTINUE_TO_TRANSFER":
        if snapshot["stage"] != "CORE" or not snapshot["transfer_ready"]:
            raise ValueError("TRANSFER_NOT_READY")
        next_snapshot.update(stage="TRANSFER", state="AWAITING_TRANSFER_ATTEMPT", **_presentation(snapshot["transfer_content"]))
        next_snapshot.update(selected_answer=None, evidence_selected=False, deferred=False, hint_level=0, hint=None, transfer_ready=False, context_selection=None)
        next_snapshot["reasoning_graph"] = None
        next_snapshot["feedback"] = f"迁移挑战：换到陌生句子，仍然先用前后关系判断“{next_snapshot['variable']}”。"
        events.append({"type": "training.transfer_started", "payload": {"source": next_snapshot["source"]}})
    elif action == "COMPLETE_SESSION":
        if not snapshot["summary_ready"]:
            raise ValueError("SUMMARY_NOT_READY")
        next_snapshot.update(state="SESSION_COMPLETED", completed=True, summary=snapshot["lesson_summary"], feedback="本关完成。你已经把一次语境判断迁移到了新的句子中。")
        events.append({"type": "training.session_completed", "payload": {"mastery": "emerging", "points": snapshot["lesson_summary"]["earned_points"]}})
    else:
        raise ValueError("UNKNOWN_COMMAND")

    next_snapshot["state_version"] = snapshot["state_version"] + 1
    return TransitionResult(next_snapshot["state"], next_snapshot, events)
