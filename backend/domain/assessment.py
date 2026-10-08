"""Version-frozen trial assessment, never a calibrated psychometric claim."""
from copy import deepcopy
from collections import Counter
from random import Random, SystemRandom

DIMENSIONS = ("vocabulary", "syntax", "context", "chapter")
LEVELS = ("L1", "L2", "L3")
WEIGHTS = {"vocabulary": .30, "syntax": .25, "context": .25, "chapter": .20}
SCORING_VERSION = "equal-tier-24-v1"
SCORING_CONFIG = {"weights": WEIGHTS, "minimum_answered_per_dimension": 4,
                  "thresholds": {"L2": 45, "L3": 75}, "minimum_correct_at_target_tier": 1}
PUBLIC_QUESTION_FIELDS = ("id", "version", "dimension", "difficulty", "stem", "source", "source_url", "passage", "options")


def valid_question(question):
    if not isinstance(question, dict):
        return False
    options = question.get("options")
    return (question.get("dimension") in DIMENSIONS and question.get("difficulty") in LEVELS
        and question.get("type") == "choice"
        and all(isinstance(question.get(key), str) and question[key].strip() for key in
                ("id", "stem", "source", "source_url", "passage", "explanation"))
        and isinstance(question.get("version"), (str, int)) and not isinstance(question["version"], bool)
        and isinstance(options, list) and len(options) >= 2
        and all(isinstance(o, dict) and isinstance(o.get("id"), str) and o["id"].strip()
                and isinstance(o.get("text"), str) and o["text"].strip() for o in options)
        and len({o["id"] for o in options}) == len(options)
        and question.get("answer_id") in {o["id"] for o in options})


def audited(question):
    return (question.get("review_status") == "APPROVED" and
            all(isinstance(question.get(k), str) and question[k].strip() for k in ("reviewer", "reviewed_at")))


def candidate_questions(bank, formal=False):
    # Duplicate stable identities are excluded rather than silently counting twice.
    counts = {}
    for q in bank:
        if isinstance(q, dict):
            counts[q.get("id")] = counts.get(q.get("id"), 0) + 1
    return [q for q in bank if valid_question(q) and counts[q["id"]] == 1
            and q.get("review_status") != "REJECTED" and (not formal or audited(q))]


def ready(questions):
    return all(sum(q["dimension"] == dimension and q["difficulty"] == level for q in questions) >= 2
               for dimension in DIMENSIONS for level in LEVELS)


def select_questions(bank, formal=False, randomizer=None):
    pool = candidate_questions(bank, formal)
    if not ready(pool):
        raise ValueError("ASSESSMENT_FORMAL_UNAVAILABLE" if formal else "ASSESSMENT_BANK_INSUFFICIENT")
    randomizer = randomizer or SystemRandom()
    if len({q["source"] for q in pool}) < 4:
        raise ValueError("ASSESSMENT_SOURCE_DIVERSITY_INSUFFICIENT")
    for _ in range(200):
        selected = []
        for dimension in DIMENSIONS:
            group = []
            for level in LEVELS:
                group.extend(randomizer.sample([q for q in pool if q["dimension"] == dimension and q["difficulty"] == level], 2))
            randomizer.shuffle(group)
            selected.extend(group)
        sources = Counter(q["source"] for q in selected)
        if len(sources) >= 4 and max(sources.values()) <= 6:
            selected = deepcopy(selected)
            for question in selected:
                randomizer.shuffle(question["options"])
            return selected
    raise ValueError("ASSESSMENT_SOURCE_DIVERSITY_INSUFFICIENT")


def can_assemble(bank, formal=False):
    """A bounded deterministic preflight; not a combinatorial feasibility proof."""
    try:
        select_questions(bank, formal, Random(0))
        return True
    except ValueError:
        return False


def public_questions(questions):
    return [{**{key: deepcopy(q[key]) for key in PUBLIC_QUESTION_FIELDS if key != "options"},
             **{key: deepcopy(q[key]) for key in ("material_extent", "passage_extent", "text_version") if key in q},
             "options": [{"id": o["id"], "text": o["text"]} for o in q["options"]]} for q in questions]


def score(snapshot):
    questions, answers = snapshot["questions"], snapshot["answers"]
    config = snapshot.get("scoring_config", SCORING_CONFIG)
    minimum = config["minimum_answered_per_dimension"]
    dimensions, reasons = {}, []
    for dimension in DIMENSIONS:
        group = [q for q in questions if q["dimension"] == dimension]
        answered = [q for q in group if answers.get(q["id"]) is not None]
        correct = sum(answers.get(q["id"]) == q["answer_id"] for q in answered)
        dimensions[dimension] = {"score": round(correct / len(group) * 100, 2) if answered else None,
            "presented_count": len(group), "answered_count": len(answered),
            "skipped_count": len(group) - len(answered), "correct_count": correct}
        if len(answered) < minimum:
            reasons.append(f"{dimension} 有效作答不足 {minimum} 题，尚不足以确认该维能力。")
    total_answered = sum(d["answered_count"] for d in dimensions.values())
    overall = round(sum((d["score"] or 0) * config["weights"][key] for key, d in dimensions.items()), 2) if total_answered else None
    sufficient = not reasons
    sufficiency = "INSUFFICIENT" if not sufficient else "HIGH" if total_answered == 24 else "MEDIUM" if total_answered >= 20 else "LOW"
    if not reasons:
        reasons.append(f"四维均有至少 {minimum} 题有效作答；充分度是试行覆盖规则，不是统计置信度。")
    level, status = None, "INSUFFICIENT"
    if snapshot["mode"] == "PILOT":
        status = "PILOT_ONLY"
        reasons.append("试用题尚未全部通过人工审核，不生成正式能力等级。")
    elif sufficient:
        status = "PROVISIONAL"
        level = "L1"
        # Advancement needs answered AND correct evidence at the target tier in every dimension.
        for target, threshold in config["thresholds"].items():
            tier_evidence = all(sum(q["dimension"] == d and q["difficulty"] == target
                and answers.get(q["id"]) == q["answer_id"] for q in questions) >= config["minimum_correct_at_target_tier"] for d in DIMENSIONS)
            if overall >= threshold and tier_evidence:
                level = target
        reasons.append(f"L2 / L3 起点另要求每维对应难度层至少答对 {config['minimum_correct_at_target_tier']} 题，阈值尚待试测校准。")
    strengths = [key for key, d in dimensions.items() if d["answered_count"] >= minimum and d["score"] >= 75]
    weaknesses = [key for key, d in dimensions.items() if d["answered_count"] >= minimum and d["score"] < 60]
    return {"overall_score": overall, "suggested_level": level, "level_status": status,
        "dimensions": dimensions, "sufficiency": sufficiency, "sufficiency_reasons": reasons,
        "strengths": strengths, "weaknesses": weaknesses,
        "explanation": "本次仅测四维选择题表现；参考分不代表翻译、开放推理或迁移能力，未测能力待评估。" +
            ("当前是待审核题目试用，不作正式能力定级。" if status == "PILOT_ONLY" else "分级规则为试行建议，不自动改变档案或积分。"),
        "review": [{"question_id": q["id"], "correct_option_id": q["answer_id"], "explanation": q["explanation"]} for q in questions]}


def transition(snapshot, command, payload):
    next_snapshot = deepcopy(snapshot)
    if snapshot["status"] != "IN_PROGRESS":
        raise ValueError("ASSESSMENT_NOT_ACTIVE")
    if command in ("SAVE_ANSWER", "SKIP_QUESTION"):
        qid = payload.get("question_id")
        question = next((q for q in snapshot["questions"] if q["id"] == qid), None)
        if question is None:
            raise ValueError("ASSESSMENT_QUESTION_INVALID")
        option = payload.get("option_id")
        if command == "SAVE_ANSWER" and option not in {o["id"] for o in question["options"]}:
            raise ValueError("ASSESSMENT_OPTION_INVALID")
        if command == "SKIP_QUESTION" and option is not None:
            raise ValueError("ASSESSMENT_PAYLOAD_INVALID")
        index = payload.get("current_index", next(i for i, q in enumerate(snapshot["questions"]) if q["id"] == qid))
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(snapshot["questions"]):
            raise ValueError("ASSESSMENT_INDEX_INVALID")
        next_snapshot["answers"][qid] = option if command == "SAVE_ANSWER" else None
        next_snapshot["current_index"] = index
    elif command == "COMPLETE_ASSESSMENT":
        if payload:
            raise ValueError("ASSESSMENT_PAYLOAD_INVALID")
        if any(q["id"] not in snapshot["answers"] for q in snapshot["questions"]):
            raise ValueError("ASSESSMENT_UNANSWERED")
        next_snapshot["status"] = "COMPLETED"
        next_snapshot["result"] = score(snapshot)
    elif command == "ABANDON_ASSESSMENT":
        if payload:
            raise ValueError("ASSESSMENT_PAYLOAD_INVALID")
        next_snapshot["status"] = "ABANDONED"
    else:
        raise ValueError("ASSESSMENT_COMMAND_INVALID")
    return next_snapshot
