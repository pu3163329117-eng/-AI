"""Curated development seed data. Existing editorial records are never overwritten."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Lesson, LessonContent


JUNIOR_CORE = {
    "source": "《宋史·范仲淹传》", "passage": "学者多从质问，为执经讲解，亡所倦。", "variable": "从",
    "question": "“从”在这里是什么意思？", "choices": ["来自", "跟从求教", "听从命令"], "evidence": "为执经讲解",
    "correct_answer": "跟从求教", "hints": ["注意“从”前后分别是谁。", "看看后半句：是谁为谁讲解经书？", "“为执经讲解”说明范仲淹正在给求学者讲解。", "在“来自、跟从求教、听从命令”中，哪个更符合求学关系？"],
    "validated_feedback": "判断成立：后文的“讲解”说明学者是求学者，因此“从”是跟从求教。",
}
JUNIOR_TRANSFER = {
    "source": "《论语·述而》", "passage": "三人行，必有我师焉；择其善者而从之。", "variable": "从",
    "question": "“从”在这里是什么意思？", "choices": ["跟随、学习", "隐藏起来", "听从命令"], "evidence": "择其善者",
    "correct_answer": "跟随、学习", "hints": ["先看“从”前面的“善者”指什么。", "“择”表示选择；选择别人的优点之后会做什么？", "“从之”里的“之”指代前面的“善者”。", "在“跟随、学习、隐藏起来、听从命令”中，哪个更符合“择其善者”？"],
    "validated_feedback": "迁移成功：先看“择其善者”，就能判断“从之”是跟随其优点去学习。",
}
SENIOR_CORE = {
    "source": "《岳阳楼记》", "passage": "微斯人，吾谁与归？", "variable": "归",
    "question": "“归”在这里是什么意思？", "choices": ["归依、志同道合", "返回家乡", "归还物品"], "evidence": "吾谁与",
    "correct_answer": "归依、志同道合", "hints": ["先看“与”表示什么关系。", "“谁与”是在问能和谁一起。", "这里的“归”不是空间上的返回，而是思想志趣上的归依。", "结合“吾谁与”，哪项最符合？"],
    "validated_feedback": "判断成立：“吾谁与归”在追问能与谁志趣相同、共同归依。",
}
SENIOR_TRANSFER = {
    "source": "《论语·颜渊》", "passage": "一日克己复礼，天下归仁焉。", "variable": "归",
    "question": "“归”在这里是什么意思？", "choices": ["归向、归附", "返回家乡", "归还物品"], "evidence": "天下",
    "correct_answer": "归向、归附", "hints": ["“天下”不是一个要返回的地点。", "看“仁”是人们共同趋向的价值。", "这里的“归”表示向某种价值靠拢。", "哪项最符合“天下归仁”？"],
    "validated_feedback": "迁移成功：“天下归仁”中的“归”表示人心归向、归附于仁。",
}


SEEDS = (
    {
        "id": "lesson-junior-cong-01", "slug": "junior-cong-01", "title": "从：从人物关系推断词义", "school_stage": "JUNIOR", "level_order": 10,
        "source": "《宋史·范仲淹传》", "difficulty": "基础", "estimated_minutes": 8, "summary": "用人物关系与行为证据理解“从”的词义。",
        "contents": {"CORE": JUNIOR_CORE, "TRANSFER": JUNIOR_TRANSFER},
    },
    {
        "id": "lesson-senior-gui-01", "slug": "senior-gui-01", "title": "归：从语境辨析抽象趋向", "school_stage": "SENIOR", "level_order": 10,
        "source": "《岳阳楼记》", "difficulty": "进阶", "estimated_minutes": 10, "summary": "通过上下文辨析“归”的抽象义，并完成迁移判断。",
        "contents": {"CORE": SENIOR_CORE, "TRANSFER": SENIOR_TRANSFER},
    },
)


def seed_lessons(db: Session) -> None:
    for seed in SEEDS:
        lesson = db.get(Lesson, seed["id"])
        if not lesson:
            lesson = Lesson(**{key: value for key, value in seed.items() if key != "contents"})
            db.add(lesson)
            db.flush()
        for stage, payload in seed["contents"].items():
            existing = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson.id, LessonContent.stage == stage))
            if not existing:
                db.add(LessonContent(lesson_id=lesson.id, stage=stage, payload=payload))
    db.commit()
