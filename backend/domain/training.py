from __future__ import annotations

from dataclasses import dataclass
from typing import Any

PASSAGE = "学者多从质问，为执经讲解，亡所倦。"
CHOICES = ["来自", "跟从求教", "听从命令"]


@dataclass(frozen=True)
class TransitionResult:
    state: str
    snapshot: dict[str, Any]
    events: list[dict[str, Any]]


def initial_snapshot() -> dict[str, Any]:
    return {
        "state": "AWAITING_INITIAL_ATTEMPT",
        "state_version": 1,
        "passage": PASSAGE,
        "variable": "从",
        "choices": CHOICES,
        "selected_answer": None,
        "evidence_selected": False,
        "deferred": False,
        "hint_level": 0,
        "hint": None,
        "feedback": "先读完整句话，再判断“从”的意思。",
        "transfer_ready": False,
        "completed": False,
    }


def _hint(level: int) -> str:
    ladder = {
        1: "注意“从”前后分别是谁。",
        2: "看看后半句：是谁为谁讲解经书？",
        3: "“为执经讲解”说明范仲淹正在给求学者讲解。",
        4: "在“来自、跟从求教、听从命令”中，哪个更符合求学关系？",
    }
    return ladder[min(level, 4)]


def apply_command(snapshot: dict[str, Any], command: dict[str, Any]) -> TransitionResult:
    """Apply one user intent. This layer deliberately has no HTTP or database imports."""
    action = command["type"]
    payload = command.get("payload", {})
    next_snapshot = dict(snapshot)
    events: list[dict[str, Any]] = []

    if snapshot["completed"]:
        raise ValueError("SESSION_COMPLETED")

    if action == "SELECT_EVIDENCE":
        next_snapshot["evidence_selected"] = True
        next_snapshot["feedback"] = "已记录证据。现在用它解释你的判断。"
        events.append({"type": "training.evidence_selected", "payload": {"evidence": "为执经讲解"}})
    elif action == "DEFER_VARIABLE":
        next_snapshot["deferred"] = True
        next_snapshot["state"] = "VARIABLE_DEFERRED"
        next_snapshot["feedback"] = "已暂放“从”。继续读到新证据后，再回来看它。"
        events.append({"type": "training.variable_deferred", "payload": {"variable": "从"}})
    elif action == "REVISIT_VARIABLE":
        if not snapshot["deferred"]:
            raise ValueError("VARIABLE_NOT_DEFERRED")
        next_snapshot["state"] = "VARIABLE_REVISITED"
        next_snapshot["feedback"] = "新证据已经出现：范仲淹在为学者讲解经书。请重新判断。"
        events.append({"type": "training.variable_revisited", "payload": {"variable": "从"}})
    elif action == "REQUEST_HINT":
        level = min(snapshot["hint_level"] + 1, 4)
        next_snapshot.update(hint_level=level, hint=_hint(level), state="HINT_PRESENTED")
        next_snapshot["feedback"] = "提示只增加一条必要信息；答案仍要由你自己作出。"
        events.append({"type": "training.hint_presented", "payload": {"level": level}})
    elif action == "SUBMIT_ATTEMPT":
        answer = payload.get("answer")
        if answer not in CHOICES:
            raise ValueError("INVALID_ANSWER")
        next_snapshot["selected_answer"] = answer
        correct = answer == "跟从求教"
        if correct and snapshot["evidence_selected"]:
            next_snapshot.update(state="ANSWER_VALIDATED", transfer_ready=True)
            next_snapshot["feedback"] = "判断成立：后文的“讲解”说明学者是求学者，因此“从”是跟从求教。"
            events.append({"type": "training.answer_validated", "payload": {"label": "CORRECT_REASONING"}})
        elif correct:
            next_snapshot["state"] = "AWAITING_REASONING"
            next_snapshot["feedback"] = "答案正确。请再选一句证据，说明你为什么这样判断。"
            events.append({"type": "training.attempt_evaluated", "payload": {"label": "CORRECT_BUT_GUESSING"}})
        else:
            next_snapshot["state"] = "AWAITING_INITIAL_ATTEMPT"
            next_snapshot["feedback"] = "这条解释暂时无法和“为执经讲解”形成关系。试着使用证据，或请求一条提示。"
            events.append({"type": "training.attempt_evaluated", "payload": {"label": "WRONG_CONTEXT"}})
    elif action == "CONTINUE_TO_TRANSFER":
        if not snapshot["transfer_ready"]:
            raise ValueError("TRANSFER_NOT_READY")
        next_snapshot.update(state="SESSION_COMPLETED", completed=True)
        next_snapshot["feedback"] = "迁移任务已解锁：在陌生文本里继续寻找“人物—行为—关系”的证据链。"
        events.append({"type": "training.session_completed", "payload": {"mastery": "emerging"}})
    else:
        raise ValueError("UNKNOWN_COMMAND")

    next_snapshot["state_version"] = snapshot["state_version"] + 1
    return TransitionResult(next_snapshot["state"], next_snapshot, events)
