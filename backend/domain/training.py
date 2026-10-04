from __future__ import annotations

from dataclasses import dataclass
from typing import Any

PASSAGE = "学者多从质问，为执经讲解，亡所倦。"
CHOICES = ["来自", "跟从求教", "听从命令"]
TRANSFER_PASSAGE = "三人行，必有我师焉；择其善者而从之。"
TRANSFER_CHOICES = ["跟随、学习", "隐藏起来", "听从命令"]


@dataclass(frozen=True)
class TransitionResult:
    state: str
    snapshot: dict[str, Any]
    events: list[dict[str, Any]]


def initial_snapshot() -> dict[str, Any]:
    return {
        "stage": "CORE",
        "state": "AWAITING_INITIAL_ATTEMPT",
        "state_version": 1,
        "source": "《宋史·范仲淹传》",
        "passage": PASSAGE,
        "variable": "从",
        "question": "“从”在这里是什么意思？",
        "choices": CHOICES,
        "evidence": "为执经讲解",
        "selected_answer": None,
        "evidence_selected": False,
        "deferred": False,
        "hint_level": 0,
        "hint": None,
        "feedback": "先读完整句话，再判断“从”的意思。",
        "transfer_ready": False,
        "summary_ready": False,
        "summary": None,
        "completed": False,
    }


def _hint(level: int, stage: str) -> str:
    core_ladder = {
        1: "注意“从”前后分别是谁。",
        2: "看看后半句：是谁为谁讲解经书？",
        3: "“为执经讲解”说明范仲淹正在给求学者讲解。",
        4: "在“来自、跟从求教、听从命令”中，哪个更符合求学关系？",
    }
    transfer_ladder = {
        1: "先看“从”前面的“善者”指什么。",
        2: "“择”表示选择；选择别人的优点之后会做什么？",
        3: "“从之”里的“之”指代前面的“善者”。",
        4: "在“跟随、学习、隐藏起来、听从命令”中，哪个更符合“择其善者”？",
    }
    return (core_ladder if stage == "CORE" else transfer_ladder)[min(level, 4)]


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
        events.append({"type": "training.evidence_selected", "payload": {"evidence": snapshot["evidence"], "stage": snapshot["stage"]}})
    elif action == "DEFER_VARIABLE":
        next_snapshot["deferred"] = True
        next_snapshot["state"] = "VARIABLE_DEFERRED"
        next_snapshot["feedback"] = "已暂放“从”。继续读到新证据后，再回来看它。"
        events.append({"type": "training.variable_deferred", "payload": {"variable": "从"}})
    elif action == "REVISIT_VARIABLE":
        if not snapshot["deferred"]:
            raise ValueError("VARIABLE_NOT_DEFERRED")
        next_snapshot["state"] = "VARIABLE_REVISITED"
        next_snapshot["feedback"] = f"新证据已经出现：{snapshot['evidence']}。请重新判断。"
        events.append({"type": "training.variable_revisited", "payload": {"variable": "从"}})
    elif action == "REQUEST_HINT":
        level = min(snapshot["hint_level"] + 1, 4)
        next_snapshot.update(hint_level=level, hint=_hint(level, snapshot["stage"]), state="HINT_PRESENTED")
        next_snapshot["feedback"] = "提示只增加一条必要信息；答案仍要由你自己作出。"
        events.append({"type": "training.hint_presented", "payload": {"level": level}})
    elif action == "SUBMIT_ATTEMPT":
        answer = payload.get("answer")
        if answer not in snapshot["choices"]:
            raise ValueError("INVALID_ANSWER")
        next_snapshot["selected_answer"] = answer
        correct_answer = "跟从求教" if snapshot["stage"] == "CORE" else "跟随、学习"
        correct = answer == correct_answer
        if correct and snapshot["evidence_selected"]:
            if snapshot["stage"] == "CORE":
                next_snapshot.update(state="ANSWER_VALIDATED", transfer_ready=True)
                next_snapshot["feedback"] = "判断成立：后文的“讲解”说明学者是求学者，因此“从”是跟从求教。"
                events.append({"type": "training.answer_validated", "payload": {"label": "CORRECT_REASONING"}})
            else:
                next_snapshot.update(state="TRANSFER_VALIDATED", summary_ready=True)
                next_snapshot["feedback"] = "迁移成功：先看“择其善者”，就能判断“从之”是跟随其优点去学习。"
                events.append({"type": "training.transfer_validated", "payload": {"label": "TRANSFER_CONFIRMED"}})
        elif correct:
            next_snapshot["state"] = "AWAITING_REASONING" if snapshot["stage"] == "CORE" else "AWAITING_TRANSFER_REASONING"
            next_snapshot["feedback"] = "答案正确。请再选一句证据，说明你为什么这样判断。"
            events.append({"type": "training.attempt_evaluated", "payload": {"label": "CORRECT_BUT_GUESSING"}})
        else:
            next_snapshot["state"] = "AWAITING_INITIAL_ATTEMPT" if snapshot["stage"] == "CORE" else "AWAITING_TRANSFER_ATTEMPT"
            next_snapshot["feedback"] = f"这条解释暂时无法和“{snapshot['evidence']}”形成关系。试着使用证据，或请求一条提示。"
            events.append({"type": "training.attempt_evaluated", "payload": {"label": "WRONG_CONTEXT"}})
    elif action == "CONTINUE_TO_TRANSFER":
        if snapshot["stage"] != "CORE" or not snapshot["transfer_ready"]:
            raise ValueError("TRANSFER_NOT_READY")
        next_snapshot.update(
            stage="TRANSFER",
            state="AWAITING_TRANSFER_ATTEMPT",
            source="《论语·述而》",
            passage=TRANSFER_PASSAGE,
            variable="从",
            question="“从”在这里是什么意思？",
            choices=TRANSFER_CHOICES,
            evidence="择其善者",
            selected_answer=None,
            evidence_selected=False,
            deferred=False,
            hint_level=0,
            hint=None,
            transfer_ready=False,
        )
        next_snapshot["feedback"] = "迁移挑战：换到陌生句子，仍然先用前后关系判断“从”。"
        events.append({"type": "training.transfer_started", "payload": {"source": "论语·述而"}})
    elif action == "COMPLETE_SESSION":
        if not snapshot["summary_ready"]:
            raise ValueError("SUMMARY_NOT_READY")
        next_snapshot.update(
            state="SESSION_COMPLETED",
            completed=True,
            summary={
                "accumulation": "“从”在求学语境中可表示跟随、学习。",
                "reasoning": "先找人物关系和行为线索，再回到目标词判断。",
                "earned_points": 20,
            },
        )
        next_snapshot["feedback"] = "本关完成。你已经把一次语境判断迁移到了新的句子中。"
        events.append({"type": "training.session_completed", "payload": {"mastery": "emerging", "points": 20}})
    else:
        raise ValueError("UNKNOWN_COMMAND")

    next_snapshot["state_version"] = snapshot["state_version"] + 1
    return TransitionResult(next_snapshot["state"], next_snapshot, events)
