"""Read-only interpretation of immutable, genuinely reviewed formal results."""
from collections import Counter
from copy import deepcopy
from datetime import datetime
from .assessment import DIMENSIONS, LEVELS, valid_question, audited

ALL_DIMENSIONS = (*DIMENSIONS, "translation", "transfer")


def formal_eligibility(snapshot, result):
    if snapshot.get("mode") != "FORMAL":
        return False, "试用题结果不作为正式能力依据。"
    if snapshot.get("status") != "COMPLETED":
        return False, "冻结测评尚未完整交卷。"
    questions = snapshot.get("questions", [])
    if not isinstance(questions, list) or len(questions) != 24 or any(not isinstance(q, dict) for q in questions):
        return False, "冻结试卷不是完整 24 题。"
    if any(not valid_question(q) or not audited(q) for q in questions):
        return False, "冻结题目缺少有效人工审核及署名。"
    if len({q["id"] for q in questions}) != 24:
        return False, "冻结试卷题目重复。"
    for question in questions:
        try:
            datetime.fromisoformat(question["reviewed_at"].replace("Z", "+00:00"))
        except ValueError:
            return False, "审核时间无效。"
    if any(sum(q["dimension"] == d and q["difficulty"] == l for q in questions) != 2 for d in DIMENSIONS for l in LEVELS):
        return False, "冻结试卷的四维分层覆盖不足。"
    sources = Counter(q["source"] for q in questions)
    if len(sources) < 4 or max(sources.values()) > 6:
        return False, "冻结试卷的来源多样性不足。"
    if not isinstance(result, dict) or result.get("level_status") not in ("PROVISIONAL", "INSUFFICIENT"):
        return False, "缺少可追溯的正式评分结果。"
    dimensions = result.get("dimensions")
    if not isinstance(dimensions, dict) or any(not isinstance(dimensions.get(d), dict) for d in DIMENSIONS):
        return False, "正式结果的维度记录不完整。"
    for name in DIMENSIONS:
        value = dimensions[name]
        if (any(type(value.get(key)) is not int for key in ("presented_count", "answered_count", "correct_count"))
                or value["presented_count"] != 6 or not 0 <= value["correct_count"] <= value["answered_count"] <= 6
                or (value.get("score") is not None and (type(value["score"]) not in (int, float) or not 0 <= value["score"] <= 100))):
            return False, "正式结果的样本记录无效。"
    if result.get("suggested_level") not in (*LEVELS, None):
        return False, "正式结果的起点无效。"
    return True, "正式评测的冻结题目审核和分层覆盖有效；评分规则仍为试行。"


def build_ability(profile_id, records):
    """records are newest first, contain immutable result plus private frozen snapshot."""
    history, eligible, fallback, latest_pilot = [], None, None, None
    for record in records:
        accepted, reason = formal_eligibility(record["snapshot"], record["result"])
        if record.get("mode", record["snapshot"]["mode"]) != record["snapshot"]["mode"]:
            accepted, reason = False, "会话类型与冻结记录不一致，不能作为正式能力依据。"
        if accepted and eligible is None:
            minimum = record["snapshot"].get("scoring_config", {}).get("minimum_answered_per_dimension", 4)
            sufficient = (record["result"]["level_status"] == "PROVISIONAL" and
                record["result"].get("suggested_level") in LEVELS and
                all(record["result"]["dimensions"][d]["answered_count"] >= minimum for d in DIMENSIONS))
            if sufficient:
                eligible = record
            elif fallback is None:
                fallback = record
        reference = {"assessment_id": record["assessment_id"], "completed_at": record["completed_at"],
            "bank_version": record["snapshot"]["bank_version"], "scoring_version": record["snapshot"]["scoring_version"],
            "result": deepcopy(record["result"])}
        if record["snapshot"]["mode"] == "PILOT" and latest_pilot is None:
            latest_pilot = reference
        if len(history) < 20:
            history.append({**reference, "mode": record["snapshot"]["mode"], "eligible_for_ability": accepted, "reason": reason})
    retained_sufficient = eligible is not None and fallback is not None
    if retained_sufficient:
        for item in history:
            if item["eligible_for_ability"] and item["result"]["level_status"] == "INSUFFICIENT":
                item["reason"] += "本次样本不足，不替换已有充分的正式能力依据。"
    eligible = eligible or fallback
    dimensions = {name: {"score": None, "presented_count": 0, "answered_count": 0, "correct_count": 0,
                         "source_assessment_id": None} for name in ALL_DIMENSIONS}
    level = None
    if eligible:
        minimum = eligible["snapshot"].get("scoring_config", {}).get("minimum_answered_per_dimension", 4)
        for name in DIMENSIONS:
            measured = eligible["result"]["dimensions"][name]
            dimensions[name] = {"score": measured["score"] if measured["answered_count"] >= minimum else None,
                "presented_count": measured["presented_count"], "answered_count": measured["answered_count"],
                "correct_count": measured["correct_count"], "source_assessment_id": eligible["assessment_id"]}
        level = eligible["result"]["suggested_level"] if eligible["result"]["level_status"] == "PROVISIONAL" else None
    return {"profile_id": profile_id, "level": level, "level_status": "PROVISIONAL" if level else "UNASSESSED",
        "source_assessment_id": eligible["assessment_id"] if eligible else None,
        "bank_version": eligible["snapshot"]["bank_version"] if eligible else None,
        "scoring_version": eligible["snapshot"]["scoring_version"] if eligible else None,
        "assessed_at": eligible["completed_at"] if eligible else None, "dimensions": dimensions,
        "latest_pilot": latest_pilot, "history": history,
        "explanation": "正式画像只采用已审核题目构成的完整正式测评；试用结果独立呈现。未测翻译、迁移和开放推理待评估，不将积分或完成次数当能力。" +
            ("较新的正式测评样本不足，保留最近一次充分的正式依据，不将起点重置为基础练习。" if retained_sufficient else "")}
