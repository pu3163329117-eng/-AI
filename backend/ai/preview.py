"""Local, voluntary shadow feedback. Never grants credit or attests correctness.

This process-local cache stores only presentation results, not student reasons.
It is not a durable receipt, authentication system, or semantic release gate.
"""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
from time import monotonic

from .deepseek import DeepSeekProvider
from .inputs import evaluator_input
from .service import FeedbackService

RUBRIC_VERSION = "reason-preview-v1"
RUBRIC = [
    {"id": "cite", "criterion": "试用、未教师审核：理由须引用所给原文中确实存在的线索，不虚构人物或行为。"},
    {"id": "relate", "criterion": "试用、未教师审核：理由须解释原文人物、动作或句法关系如何支持学生提出的词义，不仅重复结论。"},
    {"id": "limit", "criterion": "试用、未教师审核：不能凭字词常识或预设标准答案替学生补全理由。所给片段不能支持判断时，返回 UNSCORABLE 和 HUMAN_REVIEW。正确标签只是该片段下的候选意见，不是课程答案认证。"},
]
RUBRIC_LABELS = {"cite": "理由引用了原文线索", "relate": "理由说明了线索与结论的关系", "limit": "理由限定在所给材料内"}
LABELS = {
    "CORRECT_REASONING": "模型认为理由与所给片段较一致，仍需核对。",
    "CORRECT_BUT_GUESSING": "模型认为理由尚未充分说明依据；这不是对学习态度的判断。",
    "PARTIALLY_CORRECT": "模型认为理由有部分依据，还需要补充关系。",
    "WRONG_KNOWLEDGE": "模型建议重新核对字词知识，意见尚未审核。",
    "WRONG_CONTEXT": "模型建议重新核对上下文关系，意见尚未审核。",
    "WRONG_SYNTAX": "模型建议重新核对句法关系，意见尚未审核。",
    "WRONG_REASONING": "模型建议重新检查证据到结论的推断，意见尚未审核。",
    "INSUFFICIENT_EVIDENCE": "模型认为当前证据不足以支持这个判断。",
    "UNSCORABLE": "当前材料不足以可靠复核理由，请保留判断并等待人工核对。",
}
ACTIONS = {
    "REVISIT_EVIDENCE": "回到原文，核对人物、动作与前后关系，再选择证据。",
    "RETRY_REASONING": "在理由中补充：哪条原文线索，通过什么关系，支持这个词义？",
    "HUMAN_REVIEW": "不要把本次反馈当作正确性证明；结合资料或请老师核对。",
}
ERRORS = {
    "PROVIDER_TIMEOUT": "模型响应超时。本次没有得到可用反馈，可继续原有训练。",
    "RATE_LIMITED": "本机模型调用额度暂满，请稍后再试；正常训练不受影响。",
    "INVALID_OUTPUT": "模型返回未通过校验，本次不展示候选判断。",
    "SAFETY_BLOCKED": "这段输入触发安全检查。请勿在理由中填写个人信息或指令。",
    "PROVIDER_UNAVAILABLE": "模型暂不可用，本次没有完成复核；可继续原有训练。",
}


def preview_input(snapshot):
    learning = snapshot.get("learning_trace")
    stages = learning.get("stages") if isinstance(learning, dict) and learning.get("schema_version") == 1 else None
    trace = stages.get(snapshot.get("stage")) if isinstance(stages, dict) else None
    # The first response is preserved before giving additional model help.
    if not isinstance(trace, dict) or not isinstance(trace.get("first_attempt"), dict):
        raise ValueError("AI_FIRST_ATTEMPT_REQUIRED")
    payload = evaluator_input(snapshot, deepcopy(RUBRIC))
    passage = snapshot.get("passage")
    if not isinstance(passage, str) or not passage.strip() or len(passage) > 2000:
        raise ValueError("AI_INPUT_INVALID")
    # Only the current question, which is already on screen, not the whole work,
    # hidden answer, future transfer content, profile, or other training history.
    payload["visible_evidence"].append({"id": "visible-question", "text": passage})
    return payload


def presentation(result, payload, version):
    output = result.output
    references = {item["id"]: item["text"] for item in payload["visible_evidence"]}
    return {
        "mode": "SHADOW_PREVIEW", "state_version": version, "stage": payload["stage"],
        "text_version": payload["text_version"], "rubric_version": RUBRIC_VERSION,
        "rubric_review_status": "NOT_VERIFIED", "may_update_learning": False,
        "status": result.status, "error_code": result.error_code, "simulated": result.simulated,
        "summary": ERRORS[result.error_code] if result.error_code else LABELS[output["label"]],
        "next_step": "保留已保存的理由，可继续正常训练。" if result.error_code else ACTIONS[output["next_action_recommendation"]],
        "matched_criteria": [] if result.error_code else [RUBRIC_LABELS[item] for item in output["matched_rubric_items"]],
        "cited_evidence": [] if result.error_code else [{"id": item, "text": references[item]} for item in output["evidence_ids"]],
        "trace_id": result.trace["trace_id"],
    }


class PreviewRuntime:
    """One shared provider/breaker and bounded dedup cache per local process.

    Concurrent identical requests return busy instead of starting another paid
    request. Every terminal result (including failure) is cached for 10 minutes.
    Changed input/version may require a new call; refresh itself never calls.
    """
    def __init__(self, factory=DeepSeekProvider, *, clock=monotonic):
        self.factory, self.clock = factory, clock
        self.settings = None
        self.service = None
        self.cache = OrderedDict()
        self.running = False

    async def run(self, settings, session_id, version, payload):
        now = self.clock()
        key = hashlib.sha256(json.dumps([session_id, version, RUBRIC_VERSION, payload],
                                       ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if self.settings != settings:
            if self.running:
                raise ValueError("AI_FEEDBACK_BUSY")
            self.service = FeedbackService(self.factory(settings), approved_external=("deepseek",))
            self.settings = settings
            self.cache.clear()
        for stale in [k for k, (expires, _) in self.cache.items() if expires <= now]:
            self.cache.pop(stale)
        if key in self.cache:
            self.cache.move_to_end(key)
            return {**deepcopy(self.cache[key][1]), "cached": True}
        if self.running:
            raise ValueError("AI_FEEDBACK_BUSY")
        self.running = True
        try:
            result = await self.service.run("evaluator", payload)
            value = presentation(result, payload, version)
            self.cache[key] = (self.clock() + 600, deepcopy(value))
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
            return {**value, "cached": False}
        finally:
            self.running = False


runtime = PreviewRuntime()
