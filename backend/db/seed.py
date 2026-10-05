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

# The seed catalogue is deliberately authored rather than generated.  Each lesson
# has a core judgment and a transfer judgment, so a learner gets to practice the
# same reasoning move in two different contexts.
JUNIOR_QU_CORE = {
    "source": "《岳阳楼记》", "passage": "去国怀乡，忧谗畏讥。", "variable": "去",
    "question": "“去国怀乡”中的“去”是什么意思？", "choices": ["归还", "离开", "距离"], "evidence": "国、乡",
    "correct_answer": "离开", "hints": ["先看“国”和“乡”分别指什么。", "“怀乡”说明人物正在思念故乡。", "既然思念故乡，前面的动作应是离开国都。", "比较三个选项，哪个能和“怀乡”连起来？"],
    "validated_feedback": "判断成立：因离开国都，才会怀念家乡；“去”在这里是离开。",
}
JUNIOR_QU_TRANSFER = {
    "source": "《桃花源记》", "passage": "停数日，辞去。", "variable": "去",
    "question": "“辞去”中的“去”是什么意思？", "choices": ["距离", "归还", "离开"], "evidence": "辞",
    "correct_answer": "离开", "hints": ["“辞”常表示告别。", "告别之后，人会留在原处还是离开？", "把“辞去”放回桃花源的情节中理解。", "哪项能与“辞别”构成完整动作？"],
    "validated_feedback": "迁移成功：“辞”提示告别，“辞去”就是告别后离开。",
}
JUNIOR_SHU_CORE = {
    "source": "《岳阳楼记》", "passage": "属予作文以记之。", "variable": "属",
    "question": "“属予作文以记之”中的“属”是什么意思？", "choices": ["嘱托", "连接", "一类"], "evidence": "予作文",
    "correct_answer": "嘱托", "hints": ["注意“予”是接受动作的人。", "后面“作文以记之”是要我完成的事。", "把“属”和一个人、一件任务连起来看。", "哪个选项符合把任务交给别人？"],
    "validated_feedback": "判断成立：滕子京把“作文记事”的任务交给范仲淹，“属”是嘱托。",
}
JUNIOR_SHU_TRANSFER = {
    "source": "《桃花源记》", "passage": "有良田、美池、桑竹之属。", "variable": "属",
    "question": "“桑竹之属”中的“属”是什么意思？", "choices": ["嘱托", "连接", "一类"], "evidence": "良田、美池、桑竹",
    "correct_answer": "一类", "hints": ["这里“属”前面列举了多种景物。", "句中没有接受任务的人，也没有交办动作。", "列举之后常用一个词概括同类事物。", "哪个选项能概括“桑竹这一类东西”？"],
    "validated_feedback": "迁移成功：前文在列举景物，“属”用来表示同类事物，而不是嘱托。",
}
JUNIOR_ZUO_CORE = {
    "source": "《山行》", "passage": "停车坐爱枫林晚，霜叶红于二月花。", "variable": "坐",
    "question": "“停车坐爱枫林晚”中的“坐”是什么意思？", "choices": ["坐下", "因为", "犯罪"], "evidence": "爱枫林晚",
    "correct_answer": "因为", "hints": ["“停车”和“爱枫林晚”之间是什么关系？", "诗人为什么停下车？", "若解释为“坐下”，后半句能否讲通？", "哪个词能把原因和结果连起来？"],
    "validated_feedback": "判断成立：诗人因为喜爱傍晚的枫林而停车，“坐”表原因。",
}
JUNIOR_ZUO_TRANSFER = {
    "source": "《唐雎不辱使命》", "passage": "王曰：“何坐？”曰：“坐盗。”", "variable": "坐",
    "question": "“坐盗”中的“坐”是什么意思？", "choices": ["坐下", "犯罪", "因为"], "evidence": "盗",
    "correct_answer": "因为", "hints": ["“盗”指出了被问的缘由。", "这里在追问“因为什么获罪”。", "“坐”后面接的是原因，而不是座位。", "哪个选项能解释“因偷盗而获罪”？"],
    "validated_feedback": "迁移成功：“坐盗”是因偷盗而获罪，“坐”同样表原因。",
}
SENIOR_QIONG_CORE = {
    "source": "《滕王阁序》", "passage": "穷且益坚，不坠青云之志。", "variable": "穷",
    "question": "“穷且益坚”中的“穷”是什么意思？", "choices": ["走到尽头、处境困厄", "穷尽道理", "贫穷得没有钱"], "evidence": "不坠青云之志",
    "correct_answer": "走到尽头、处境困厄", "hints": ["后半句强调志向不能坠落。", "这说明人物面对的是逆境，而非单纯描述财物。", "“且益坚”是逆境中的精神选择。", "哪个选项最能概括人生处境的困顿？"],
    "validated_feedback": "判断成立：“穷”写人生遭遇困厄，仍要坚定志向。",
}
SENIOR_QIONG_TRANSFER = {
    "source": "《孟子·尽心上》", "passage": "穷则独善其身，达则兼善天下。", "variable": "穷",
    "question": "“穷则独善其身”中的“穷”是什么意思？", "choices": ["穷尽", "处境困厄、不得志", "钱财贫乏"], "evidence": "达则",
    "correct_answer": "处境困厄、不得志", "hints": ["把“穷”与后面的“达”对照。", "“达”指仕途通达、能够施展抱负。", "相对的“穷”应是不得志的处境。", "哪项与“达”形成恰当对照？"],
    "validated_feedback": "迁移成功：与“达”相对时，“穷”指不得志、处境困厄。",
}
SENIOR_JIA_CORE = {
    "source": "《劝学》", "passage": "君子生非异也，善假于物也。", "variable": "假",
    "question": "“善假于物”中的“假”是什么意思？", "choices": ["假装", "借助", "给予"], "evidence": "于物",
    "correct_answer": "借助", "hints": ["“于物”说明动作的对象是外物。", "句子在解释君子为何能有成就。", "人怎样利用工具、条件来提升自己？", "哪个选项能接在“善__于物”中？"],
    "validated_feedback": "判断成立：君子善于借助外物条件，“假”是借助。",
}
SENIOR_JIA_TRANSFER = {
    "source": "《送东阳马生序》", "passage": "余故道为学之难以告之，且告之以此；以是人多以书假余。", "variable": "假",
    "question": "“以书假余”中的“假”是什么意思？", "choices": ["借助", "假装", "借给"], "evidence": "以书、余",
    "correct_answer": "借给", "hints": ["“书”是被交出的物品，“余”是接受者。", "想一想：是谁把书交给谁？", "“以书假余”不是我借助书，而是别人把书给我。", "哪个选项符合物品从他人交到“余”手中？"],
    "validated_feedback": "迁移成功：书交给“余”，因此“假”是借给，不是借助。",
}
SENIOR_YI_CORE = {
    "source": "《师说》", "passage": "余嘉其能行古道，作《师说》以贻之。", "variable": "贻",
    "question": "“以贻之”中的“贻”是什么意思？", "choices": ["遗忘", "赠送", "留下遗憾"], "evidence": "作《师说》",
    "correct_answer": "赠送", "hints": ["“之”指代前文值得赞许的李蟠。", "作者写成文章之后，会怎样处理这篇文章？", "注意“作”与“贻”构成先后动作。", "哪个选项符合把文章交给别人？"],
    "validated_feedback": "判断成立：韩愈写《师说》送给李蟠，“贻”是赠送。",
}
SENIOR_YI_TRANSFER = {
    "source": "《核舟记》", "passage": "尝贻余核舟一，盖大苏泛赤壁云。", "variable": "贻",
    "question": "“尝贻余核舟一”中的“贻”是什么意思？", "choices": ["遗忘", "留下遗憾", "赠送"], "evidence": "余、核舟一",
    "correct_answer": "赠送", "hints": ["“余”是接受者，“核舟一”是物品。", "判断物品的流向：谁把核舟给了谁？", "这里不是遗失物品，而是交给“我”。", "哪个选项能说明把核舟送给我？"],
    "validated_feedback": "迁移成功：核舟交到“余”手中，“贻”仍是赠送。",
}


SEEDS = (
    {
        "id": "lesson-junior-cong-01", "slug": "junior-cong-01", "title": "从：从人物关系推断词义", "school_stage": "JUNIOR", "level_order": 10,
        "source": "《宋史·范仲淹传》", "difficulty": "基础", "estimated_minutes": 8, "summary": "用人物关系与行为证据理解“从”的词义。",
        "textbook_tags": ["初中文言文", "实词"], "theme": "人物关系", "reasoning_level": "L1·语境取证",
        "accumulation_points": ["从：跟从求教"], "reasoning_points": ["人物关系", "行为证据"],
        "contents": {"CORE": JUNIOR_CORE, "TRANSFER": JUNIOR_TRANSFER},
    },
    {
        "id": "lesson-senior-gui-01", "slug": "senior-gui-01", "title": "归：从语境辨析抽象趋向", "school_stage": "SENIOR", "level_order": 10,
        "source": "《岳阳楼记》", "difficulty": "进阶", "estimated_minutes": 10, "summary": "通过上下文辨析“归”的抽象义，并完成迁移判断。",
        "textbook_tags": ["高中文言文", "实词"], "theme": "抽象义辨析", "reasoning_level": "L2·语境迁移",
        "accumulation_points": ["归：归依、归向"], "reasoning_points": ["抽象趋向", "迁移判断"],
        "contents": {"CORE": SENIOR_CORE, "TRANSFER": SENIOR_TRANSFER},
    },
    {
        "id": "lesson-junior-qu-01", "slug": "junior-qu-01", "title": "去：从前后动作判断离开义", "school_stage": "JUNIOR", "level_order": 20,
        "source": "《岳阳楼记》", "difficulty": "基础", "estimated_minutes": 8, "summary": "借助告别、思乡等动作线索理解“去”的离开义。",
        "textbook_tags": ["初中文言文", "实词", "一词多义"], "theme": "动作线索", "reasoning_level": "L1·语境取证",
        "accumulation_points": ["去：离开"], "reasoning_points": ["动作关系", "上下文互证"],
        "contents": {"CORE": JUNIOR_QU_CORE, "TRANSFER": JUNIOR_QU_TRANSFER},
    },
    {
        "id": "lesson-junior-shu-01", "slug": "junior-shu-01", "title": "属：看结构辨析嘱托与同类", "school_stage": "JUNIOR", "level_order": 30,
        "source": "《岳阳楼记》", "difficulty": "进阶", "estimated_minutes": 10, "summary": "通过宾语和列举结构，辨析“属”的不同词义。",
        "textbook_tags": ["初中文言文", "实词", "一词多义"], "theme": "结构辨析", "reasoning_level": "L2·语境迁移",
        "accumulation_points": ["属：嘱托；一类"], "reasoning_points": ["宾语判断", "列举结构"],
        "contents": {"CORE": JUNIOR_SHU_CORE, "TRANSFER": JUNIOR_SHU_TRANSFER},
    },
    {
        "id": "lesson-junior-zuo-01", "slug": "junior-zuo-01", "title": "坐：从因果关系读出原因义", "school_stage": "JUNIOR", "level_order": 40,
        "source": "《山行》", "difficulty": "进阶", "estimated_minutes": 9, "summary": "从动作的原因和结果中理解“坐”的原因义。",
        "textbook_tags": ["初中文言文", "实词", "古今异义"], "theme": "因果关系", "reasoning_level": "L2·语境迁移",
        "accumulation_points": ["坐：因为"], "reasoning_points": ["因果链", "句间关系"],
        "contents": {"CORE": JUNIOR_ZUO_CORE, "TRANSFER": JUNIOR_ZUO_TRANSFER},
    },
    {
        "id": "lesson-senior-qiong-01", "slug": "senior-qiong-01", "title": "穷：在对照中辨析困厄义", "school_stage": "SENIOR", "level_order": 20,
        "source": "《滕王阁序》", "difficulty": "进阶", "estimated_minutes": 10, "summary": "借助志向与通达的对照，理解“穷”的人生处境义。",
        "textbook_tags": ["高中文言文", "实词", "对照阅读"], "theme": "处境与志向", "reasoning_level": "L2·语境迁移",
        "accumulation_points": ["穷：处境困厄、不得志"], "reasoning_points": ["对照关系", "抽象语境"],
        "contents": {"CORE": SENIOR_QIONG_CORE, "TRANSFER": SENIOR_QIONG_TRANSFER},
    },
    {
        "id": "lesson-senior-jia-01", "slug": "senior-jia-01", "title": "假：从施受关系辨析借用", "school_stage": "SENIOR", "level_order": 30,
        "source": "《劝学》", "difficulty": "进阶", "estimated_minutes": 11, "summary": "通过物品与人物的流向，辨析“假”的借助义和借给义。",
        "textbook_tags": ["高中文言文", "实词", "一词多义"], "theme": "施受关系", "reasoning_level": "L2·语境迁移",
        "accumulation_points": ["假：借助；借给"], "reasoning_points": ["施事受事", "语法关系"],
        "contents": {"CORE": SENIOR_JIA_CORE, "TRANSFER": SENIOR_JIA_TRANSFER},
    },
    {
        "id": "lesson-senior-yi-01", "slug": "senior-yi-01", "title": "贻：从物品流向判断赠送义", "school_stage": "SENIOR", "level_order": 40,
        "source": "《师说》", "difficulty": "基础", "estimated_minutes": 9, "summary": "通过接受者与物品的关系，稳固“贻”的赠送义。",
        "textbook_tags": ["高中文言文", "实词", "宾语判断"], "theme": "物品流向", "reasoning_level": "L1·语境取证",
        "accumulation_points": ["贻：赠送"], "reasoning_points": ["施受关系", "宾语判断"],
        "contents": {"CORE": SENIOR_YI_CORE, "TRANSFER": SENIOR_YI_TRANSFER},
    },
)


def seed_lessons(db: Session) -> None:
    for seed in SEEDS:
        lesson = db.get(Lesson, seed["id"])
        if not lesson:
            lesson = Lesson(**{key: value for key, value in seed.items() if key != "contents"})
            db.add(lesson)
            db.flush()
        else:
            # The first local catalogue pre-dates editorial metadata.  Backfill
            # only empty curated fields so pre-existing learner-visible lessons
            # can participate in targeted practice without overwriting an
            # editor's later changes.
            for field in (
                "textbook_tags",
                "theme",
                "reasoning_level",
                "accumulation_points",
                "reasoning_points",
            ):
                if not getattr(lesson, field):
                    setattr(lesson, field, seed[field])
        for stage, payload in seed["contents"].items():
            existing = db.scalar(select(LessonContent).where(LessonContent.lesson_id == lesson.id, LessonContent.stage == stage))
            if not existing:
                db.add(LessonContent(lesson_id=lesson.id, stage=stage, payload=payload))
    db.commit()
