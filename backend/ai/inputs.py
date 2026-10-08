"""Allowlist projection from a frozen training snapshot; never send a raw snapshot.

    Rubric is supplied separately by trusted content code. It is not inferred
    from evidence coverage, a selected answer, or an arbitrary student string.
"""
from .contracts import EvaluatorInput, TeacherInput


def evidence(snapshot, selection):
    try:
        paragraphs = snapshot["reading_context"]["paragraphs"]
        paragraph, start, end = (selection[k] for k in ("paragraph_index", "start", "end"))
        if any(type(v) is not int for v in (paragraph, start, end)) or not 0 <= paragraph < len(paragraphs):
            raise ValueError()
        text = paragraphs[paragraph]
        if not isinstance(text, str) or not 0 <= start < end <= len(text) or end - start > 80:
            raise ValueError()
        token = text[start:end]
        if token != selection["token"] or not token.strip():
            raise ValueError()
        return {"id": f"e-p{paragraph}-s{start}-e{end}", "text": token}
    except (KeyError, TypeError, ValueError, IndexError):
        raise ValueError("AI_INPUT_INVALID") from None


def teacher_input(snapshot):
    try:
        value = {"stage": snapshot["stage"], "text_version": snapshot["reading_context"]["text_version"],
                 "target": snapshot["variable"], "hint_level": snapshot["hint_level"],
                 "visible_evidence": [evidence(snapshot, snapshot["context_selection"])]}
        return TeacherInput.model_validate(value).model_dump()
    except (KeyError, ValueError, TypeError):
        raise ValueError("AI_INPUT_INVALID") from None


def evaluator_input(snapshot, rubric):
    try:
        graph = snapshot["reasoning_graph"]
        version = snapshot["reading_context"]["text_version"]
        if graph["stage"] != snapshot["stage"] or graph["text_version"] != version or graph["target"] != snapshot["variable"]:
            raise ValueError()
        value = {"stage": snapshot["stage"], "text_version": version, "target": graph["target"],
                 "visible_evidence": [evidence(snapshot, graph["evidence"])],
                 "student_reason": graph["reason"], "student_conclusion": graph["conclusion"], "rubric": rubric}
        return EvaluatorInput.model_validate(value).model_dump()
    except (KeyError, ValueError, TypeError):
        raise ValueError("AI_INPUT_INVALID") from None
