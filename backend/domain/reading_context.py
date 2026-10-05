"""Canonical reading contexts used by the in-session full-text reader.

The training prompt is intentionally short; this module supplies the surrounding
reading unit and bibliographic layer without making the learner fetch a second
resource.  Unknown editorial sources still receive a useful, honest fallback.
"""
from __future__ import annotations

from typing import Any


_READING_CONTEXTS: dict[str, dict[str, Any]] = {
    "《宋史·范仲淹传》": {
        "author": "脱脱等",
        "era": "元代 · 纪传体史书",
        "work_note": "本课所用《范仲淹传》节选",
        "paragraphs": [
            "范仲淹二岁而孤，家贫无依。少有大志，每以天下为己任。发愤苦读，或夜昏怠，辄以水沃面。",
            "既仕，慷慨论天下事。学者多从质问，为执经讲解，亡所倦。",
        ],
    },
    "《论语·述而》": {
        "author": "孔子弟子及再传弟子",
        "era": "春秋末至战国初 · 语录体",
        "work_note": "《述而》篇章节",
        "paragraphs": ["子曰：三人行，必有我师焉；择其善者而从之，其不善者而改之。"],
    },
    "《岳阳楼记》": {
        "author": "范仲淹",
        "era": "北宋 · 散文",
        "work_note": "庆历六年为岳阳楼作记",
        "paragraphs": [
            "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。属予作文以记之。",
            "予观夫巴陵胜状，在洞庭一湖。衔远山，吞长江，浩浩汤汤，横无际涯；朝晖夕阴，气象万千。此则岳阳楼之大观也，前人之述备矣。",
            "若夫淫雨霏霏，连月不开，阴风怒号，浊浪排空；日星隐曜，山岳潜形；商旅不行，樯倾楫摧；薄暮冥冥，虎啸猿啼。登斯楼也，则有去国怀乡，忧谗畏讥，满目萧然，感极而悲者矣。",
            "至若春和景明，波澜不惊，上下天光，一碧万顷；沙鸥翔集，锦鳞游泳；岸芷汀兰，郁郁青青。登斯楼也，则有心旷神怡，宠辱偕忘，把酒临风，其喜洋洋者矣。",
            "嗟夫！予尝求古仁人之心，或异二者之为，何哉？不以物喜，不以己悲；居庙堂之高则忧其民；处江湖之远则忧其君。是进亦忧，退亦忧。然则何时而乐耶？其必曰“先天下之忧而忧，后天下之乐而乐”乎。噫！微斯人，吾谁与归？",
        ],
    },
    "《论语·颜渊》": {
        "author": "孔子弟子及再传弟子",
        "era": "春秋末至战国初 · 语录体",
        "work_note": "《颜渊》篇章节",
        "paragraphs": ["颜渊问仁。子曰：克己复礼为仁。一日克己复礼，天下归仁焉。为仁由己，而由人乎哉？"],
    },
    "《桃花源记》": {
        "author": "陶渊明",
        "era": "东晋 · 志怪体散文",
        "work_note": "以渔人行踪组织的理想社会寓言",
        "paragraphs": [
            "晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。渔人甚异之，复前行，欲穷其林。",
            "林尽水源，便得一山，山有小口，仿佛若有光。便舍船，从口入。初极狭，才通人。复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田、美池、桑竹之属。",
            "见渔人，乃大惊，问所从来。具答之。便要还家，设酒杀鸡作食。村中闻有此人，咸来问讯。自云先世避秦时乱，率妻子邑人来此绝境，不复出焉，遂与外人间隔。",
            "停数日，辞去。此中人语云：不足为外人道也。既出，得其船，便扶向路，处处志之。",
        ],
    },
    "《山行》": {
        "author": "杜牧",
        "era": "晚唐 · 七言绝句",
        "work_note": "秋山行旅中的所见所感",
        "paragraphs": ["远上寒山石径斜，白云生处有人家。停车坐爱枫林晚，霜叶红于二月花。"],
    },
    "《唐雎不辱使命》": {
        "author": "《晏子春秋》相关对话节选",
        "era": "先秦 · 国别与人物故事传统",
        "work_note": "本课题文使用“坐盗”对话节选；题源待教研统一校勘",
        "paragraphs": ["王曰：何坐？曰：坐盗。王曰：齐人固善盗乎？晏子避席对曰：婴闻之，橘生淮南则为橘，生于淮北则为枳，叶徒相似，其实味不同。"],
    },
    "《滕王阁序》": {
        "author": "王勃",
        "era": "初唐 · 骈文",
        "work_note": "洪州宴集所作名篇",
        "paragraphs": [
            "时维九月，序属三秋。潦水尽而寒潭清，烟光凝而暮山紫。俨骖騑于上路，访风景于崇阿；临帝子之长洲，得天人之旧馆。",
            "关山难越，谁悲失路之人；萍水相逢，尽是他乡之客。怀帝阍而不见，奉宣室以何年？",
            "嗟乎！时运不齐，命途多舛；冯唐易老，李广难封。屈贾谊于长沙，非无圣主；窜梁鸿于海曲，岂乏明时？所赖君子见机，达人知命。穷且益坚，不坠青云之志。",
        ],
    },
    "《孟子·尽心上》": {
        "author": "孟子及其弟子",
        "era": "战国中期 · 语录体",
        "work_note": "《尽心上》篇章节",
        "paragraphs": ["孟子曰：穷则独善其身，达则兼善天下。"],
    },
    "《劝学》": {
        "author": "荀子",
        "era": "战国末期 · 论说文",
        "work_note": "《荀子》首篇节选",
        "paragraphs": [
            "君子曰：学不可以已。青，取之于蓝，而青于蓝；冰，水为之，而寒于水。木直中绳，輮以为轮，其曲中规。故木受绳则直，金就砺则利，君子博学而日参省乎己，则知明而行无过矣。",
            "吾尝终日而思矣，不如须臾之所学也；吾尝跂而望矣，不如登高之博见也。登高而招，臂非加长也，而见者远；顺风而呼，声非加疾也，而闻者彰。假舆马者，非利足也，而致千里；假舟楫者，非能水也，而绝江河。君子生非异也，善假于物也。",
        ],
    },
    "《送东阳马生序》": {
        "author": "宋濂",
        "era": "明初 · 赠序",
        "work_note": "自叙求学经历以勉励后学",
        "paragraphs": [
            "余幼时即嗜学。家贫，无从致书以观，每假借于藏书之家，手自笔录，计日以还。天大寒，砚冰坚，手指不可屈伸，弗之怠。录毕，走送之，不敢稍逾约。以是人多以书假余，余因得遍观群书。",
            "余故道为学之难以告之，且告之以此。",
        ],
    },
    "《师说》": {
        "author": "韩愈",
        "era": "中唐 · 论说文",
        "work_note": "为李蟠作的从师论说",
        "paragraphs": [
            "古之学者必有师。师者，所以传道受业解惑也。人非生而知之者，孰能无惑？惑而不从师，其为惑也，终不解矣。",
            "是故无贵无贱，无长无少，道之所存，师之所存也。是故弟子不必不如师，师不必贤于弟子，闻道有先后，术业有专攻，如是而已。",
            "李氏子蟠，年十七，好古文，六艺经传皆通习之，不拘于时，学于余。余嘉其能行古道，作《师说》以贻之。",
        ],
    },
    "《核舟记》": {
        "author": "魏学洢",
        "era": "明末 · 说明文",
        "work_note": "记述微雕核舟艺术",
        "paragraphs": [
            "明有奇巧人曰王叔远，能以径寸之木，为宫室、器皿、人物，以至鸟兽、木石，罔不因势象形，各具情态。尝贻余核舟一，盖大苏泛赤壁云。",
            "舟首尾长约八分有奇，高可二黍许。中轩敞者为舱，箬篷覆之。旁开小窗，左右各四，共八扇。",
        ],
    },
}


def reading_context_for(content: dict[str, Any]) -> dict[str, Any]:
    """Return a snapshot-safe full-text context for an authored content payload."""
    source = content["source"]
    supplied = content.get("reading_context")
    base = _READING_CONTEXTS.get(source, {})
    context = supplied if isinstance(supplied, dict) else base
    paragraphs = context.get("paragraphs") if isinstance(context, dict) else None
    valid_paragraphs = [item.strip() for item in paragraphs or [] if isinstance(item, str) and item.strip()]
    if not valid_paragraphs:
        valid_paragraphs = [content["passage"]]
    return {
        "paragraphs": valid_paragraphs,
        "full_text": "\n\n".join(valid_paragraphs),
        "author": str(context.get("author") or "作者信息待教研补充"),
        "era": str(context.get("era") or "时代信息待教研补充"),
        "work_note": str(context.get("work_note") or "当前课内原文"),
    }
