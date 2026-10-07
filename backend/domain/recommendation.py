"""Small honest queues, not fabricated 70/20/10 ratios or automatic promotion."""
LEVELS = ("L1", "L2", "L3")
DIMENSION_LABELS = {"vocabulary": "字词", "syntax": "句式", "context": "语境", "chapter": "篇章",
                    "translation": "翻译", "transfer": "迁移"}
CATEGORY_LABELS = {"MAIN": "主线", "REINFORCEMENT": "补强", "CHALLENGE": "挑战"}


def choose(candidates, practice_level, dimensions):
    weaknesses = [name for name, value in dimensions.items() if value["score"] is not None and value["answered_count"] >= 4 and value["score"] < 60]
    reinforcement_level = LEVELS[max(0, LEVELS.index(practice_level) - 1)]
    challenge_level = LEVELS[min(2, LEVELS.index(practice_level) + 1)]
    picked, used, gaps = [], set(), []
    specs = [("MAIN", practice_level, "匹配当前练习起点的主线训练。"),
             ("REINFORCEMENT", reinforcement_level, "针对正式测评中有足够样本的薄弱维度进行补强。"),
             ("CHALLENGE", challenge_level, "尝试新的材料与训练目标；不改变正式能力等级。")]
    for category, level, reason in specs:
        if category == "REINFORCEMENT" and not weaknesses:
            gaps.append("尚无有足够正式样本的薄弱维度，本轮不编造补强任务。")
            continue
        available = [c for c in candidates if c["ability_level"] == level and c["lesson_id"] not in used and
                     (category != "REINFORCEMENT" or any(tag in weaknesses for tag in c["dimension_tags"]))]
        if not available:
            gaps.append(f"{CATEGORY_LABELS[category]}：缺少 {level} 已审核、有效标定且未完成的匹配课程。")
            continue
        item = available[0]
        used.add(item["lesson_id"])
        picked.append({**item, "category": category, "reason": reason +
                       ("匹配维度：" + "、".join(DIMENSION_LABELS[tag] for tag in item["dimension_tags"] if tag in weaknesses) if category == "REINFORCEMENT" else "")})
    return picked, gaps
