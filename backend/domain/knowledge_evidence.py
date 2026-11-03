"""Small, web-checked ORIGINAL-TEXT candidates, never an annotation seed.

These are locations of ancient text, not dictionary evidence for the current
gloss. No import/apply/review operation is provided. Positions use Python Unicode
codepoints in the pinned teaching edition; source_quote preserves the separately
checked transcription. Wikisource is a transcription repository, not an official
modern critical edition or teacher certification.
"""
from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5


VERSION = 'knowledge-evidence-v1'
BATCH_ID = 'core-eight-20261025'
TOKENS = ('从', '假', '去', '坐', '属', '归', '穷', '贻')
CHECKED_ON = '2026-10-25'  # UTC web-check date, NOT the work's publication date.

# Immutable metadata copied from the public, already-existing teaching corpus.
# Pinning here means a later corpus change cannot silently relocate candidates.
_MATERIALS = {
    '《宋史·范仲淹传》': ('d87ea3e8289525bbcb28aed75fec3b4bcbf08cc0e2297d69d1f5fa025c819ac9', 'EXCERPT',
        '2026-10-06 · 原文来源核对；简体教学标点；寘、亡、奉依所链原文；余与馀统一显示为余'),
    '《论语·述而》': ('d54084d15f5e614b73e1988f173ccf248655dc71e578561f333ae0c98f71dbc9', 'CHAPTER',
        '2026-10-06 · 所链页面廿一章中文原文；简体教学标点，不采用网页英文译文；常见本分作7.22'),
    '《劝学》': ('899913ade38a5518194a6f9cefe8f85f7dcf16ed3d5cf5a996f72cc347059b65', 'EXCERPT',
        '2026-10-06 · 原文来源核对；简体教学标点；輮、有、知、生、六跪依所链原文；无现代注释；不额外添加其他版本白沙句'),
    '《送东阳马生序》': ('f8c3e6e86dbcd669b3c37d992f191dedcb88c9211210d6bd60b5d95ed94a953b', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；缊袍、四支依所链原文；结尾没有且告之以此，不将首尾拼接'),
    '《岳阳楼记》': ('46e753f5e4abfd96324300d6fa0208efb4571ea99e6a87efcf39a3c6e674b26e', 'FULL',
        '2026-10-06 · 简体教学标点；淫、曜、乎异文'),
    '《桃花源记》': ('2a3c2ef576146e259fbde1696eccaf7b2d53c88135936280481b4c8257ed199b', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；采用太元、杂树、衣着、余人、规往等字形；不含配诗及现代注释'),
    '《山行》': ('810e7969b4c981dcdff4a57fff01de8cfd5a62d133f20fc3899c7cc64090a3d7', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；采用白云生处；白云深处为另一传本文字'),
    '《晏子春秋·内篇杂下》': ('97438e099cb0e13a47c35261d8e0435819b6ff9d2db9dbfa17a0828acaa89892', 'CHAPTER',
        '2026-10-06 · 四库全书本卷六相应章；简体教学标点；将至楚、嬉依所链底本；不含相邻进橘故事'),
    '《论语·颜渊》': ('0ea4ee5ef8cf49a143604ee2f1bf9ba0443ee11211ebd29a4c93e8e645fbc157', 'CHAPTER',
        '2026-10-06 · 所链页面第一章中文原文；简体教学标点，不采用网页英文译文'),
    '《滕王阁序》': ('2e4931cfde7ebac5f48f44ed47d78b09dd0e133fd610fbc4b1aa2a56883b0214', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；采用豫章、层台、云销、见机、命途、三尺、珠帘等所链页面异文；含结尾诗'),
    '《孟子·尽心上》': ('dc6e4a1da107ca72517c80d7eeb135259010504af2a8d269a38deae874d8d745', 'CHAPTER',
        '2026-10-06 · 原文来源核对；简体教学标点；对话依原篇顺序，不将结句单列冒充全文'),
    '《师说》': ('7ff1d957f019a9f3fc3716089b27119ad7236f85ce5be4e4b72fa94ece4986cb', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；受业、不焉依所链原文；段落为阅读展示划分'),
    '《核舟记》': ('0364fd98d6dc9ee90a7de019c9351dc89c355a6584b8e13b7ebfcfab88d96523', 'FULL',
        '2026-10-06 · 原文来源核对；简体教学标点；诎、衡、甫、有、简依所链原文；包含末段而非教材六段节选'),
}

# slug, token, source, paragraph, start, sense, exact local sentence,
# primary text URL/title/locator/quote, explicit transcription/scope differences.
_SPECS = (
    ('cong-songshi', '从', '《宋史·范仲淹传》', 1, 107, 'cong.learn_from',
     '仲淹泛通《六经》，长于《易》，学者多从质问，为执经讲解，亡所倦。',
     'https://zh.wikisource.org/zh-hans/宋史/卷314', '《宋史》卷三百十四·范仲淹传',
     '列传第七十三·范仲淹；“监泰州西溪盐税”段内“仲淹泛通《六经》”句',
     '仲淹泛通《六经》，长于《易》，学者多从质问，为执经讲解，亡所倦。',
     '网页简体转写与本句文字相合；本平台仅传记连续节选，不是《宋史》全卷或整传。'),
    ('cong-lunyu', '从', '《论语·述而》', 0, 19, 'cong.learn_follow',
     '择其善者而从之，其不善者而改之。',
     'https://en.wikisource.org/wiki/The_Chinese_Classics/Volume_1/Confucian_Analects/VII',
     '《论语·述而》中文原文（The Chinese Classics, Volume 1）',
     'VII·述而；页面标作〖廿一章〗，“子曰、三人行”章',
     '子曰、三人行、必有我師焉、擇其善者而從之、其不善者而改之。',
     '引文保留繁体和顿号；本地为简体教学标点、展示整章中的当前句。该页面章号与常见7.22不同；不采用英文译文。'),
    ('jia-xunzi', '假', '《劝学》', 2, 65, 'jia.borrow',
     '假舆马者，非利足也，而致千里；假舟楫者，非能水也，而绝江河。',
     'https://zh.wikisource.org/wiki/荀子/勸學篇', '《荀子·劝学篇》',
     '“吾嘗終日而思矣”段；“假輿馬者”句',
     '假輿馬者，非利足也，而致千里；假舟楫者，非能水也，而絶江河。',
     '原典转写保留輿、絶等字形，本地用舆、绝；本平台为连续节选，不是整篇。链接只支持原句存在，不支持借助义已经辞书审定。'),
    ('jia-songdongyang', '假', '《送东阳马生序》', 0, 74, 'jia.lend',
     '以是人多以书假余，余因得遍观群书。',
     'https://zh.wikisource.org/zh-hans/送東陽馬生序', '宋濂《送东阳马生序》',
     '首段“录毕，走送之”后“以是人多以书假余”句；页列《明文海》卷285',
     '以是人多以书假余，余因得遍观群书。',
     '简体网页本句与本地相合；本地范围为全文，段落按阅读分组。此处与《劝学》同字，不自动判定同义。'),
    ('qu-yueyang', '去', '《岳阳楼记》', 2, 59, 'qu.leave',
     '登斯楼也，则有去国怀乡，忧谗畏讥，满目萧然，感极而悲者矣。',
     'https://zh.wikisource.org/zh-hans/岳陽樓記', '范仲淹《岳阳楼记》',
     '“若夫霪雨霏霏”段末，“登斯楼也”句；页列《范文正公集》卷07',
     '登斯楼也，则有去国怀乡，忧谗畏讥，满目萧然，感极而悲者矣。',
     '目标句简体字相合；段首淫／霪、曜／耀等版本异文不在此句，本地采用已登记教学版本，未改原文。'),
    ('qu-taohuayuan', '去', '《桃花源记》', 2, 123, 'qu.leave', '停数日，辞去。',
     'https://zh.wikisource.org/zh-hans/桃花源記', '陶渊明《桃花源记》',
     '“停数日，辞去”句；页列《笺注陶渊明集》卷5', '停数日，辞去。',
     '目标句简体字相合；平台范围是记的全文，不含配诗、网页异文标记及现代注释。'),
    ('zuo-shanxing', '坐', '《山行》', 0, 18, 'zuo.cause', '停车坐爱枫林晚，霜叶红于二月花。',
     'https://zh.wikisource.org/zh-hans/山行_(杜牧)', '杜牧《山行》',
     '四句诗第三、四句；页列《樊川文集》外集一卷', '停车坐爱枫林晚\n霜叶红于二月花',
     '原典摘录保留网页两行、无标点形式；本地合并为一段并加逗号、句号教学标点。白云生处／深处异文不影响目标句。原典不等于因为义的辞书出处。'),
    ('zuo-yanzi', '坐', '《晏子春秋·内篇杂下》', 1, 52, 'zuo.offence', '’曰：‘坐盗。',
     'https://zh.wikisource.org/zh-hans/晏子春秋_(四庫全書本)/全覽', '《晏子春秋》（四库全书本）卷六',
     '内篇·杂下第六；“晏子将至楚”章，楚王与左右预谋对话的第一次“何坐”后',
     '王曰何坐曰坐盗',
     '所核原典无现代引号、标点；本地加教学标点，现有句界索引含前句闭引号。按原段52—53码点绑定第一次“坐盗”，不是后段复述；不含相邻进橘故事。'),
    ('shu-yueyang', '属', '《岳阳楼记》', 0, 52, 'zhu.entrust', '属予作文以记之。',
     'https://zh.wikisource.org/zh-hans/岳陽樓記', '范仲淹《岳阳楼记》',
     '首段末“属予作文以记之”；页列《范文正公集》卷07', '属予作文以记之。',
     '目标句简体字相合；原典只提供该句语境，不作为通嘱／读音zhǔ的辞书审定证据。'),
    ('shu-taohuayuan', '属', '《桃花源记》', 1, 68, 'shu.kind', '有良田、美池、桑竹之属。',
     'https://zh.wikisource.org/zh-hans/桃花源記', '陶渊明《桃花源记》',
     '“土地平旷，屋舍俨然”后“桑竹之属”；页列《笺注陶渊明集》卷5', '有良田、美池、桑竹之属。',
     '目标句简体字相合；与“属予作文”仅作为同字跨篇候选，不合并义项或判断读音。'),
    ('gui-yueyang', '归', '《岳阳楼记》', 4, 100, 'gui.identify_with', '微斯人，吾谁与归？',
     'https://zh.wikisource.org/zh-hans/岳陽樓記', '范仲淹《岳阳楼记》',
     '末论段“噫！微斯人，吾谁与归”；页列《范文正公集》卷07', '噫！微斯人，吾谁与归？',
     '本地句界按感叹号切分，当前句不含“噫”；原典引文保留前置感叹。原句不直接认证归依义。'),
    ('gui-lunyu', '归', '《论语·颜渊》', 0, 25, 'gui.approve', '一日克己复礼，天下归仁焉。',
     'https://en.wikisource.org/wiki/The_Chinese_Classics/Volume_1/Confucian_Analects/XII',
     '《论语·颜渊》中文原文（The Chinese Classics, Volume 1）',
     'XII·颜渊；〖第一章〗〖一节〗“颜渊问仁”', '子曰、克己復禮爲仁、一日克己復禮、天下歸仁焉、爲仁由己、而由人乎哉。',
     '原典为繁体、顿号且这段话为一句，本地用简体教学标点切为多句；不采用英文译文。原句不证明赞许义，释义需另行注家／辞书核对。'),
    ('qiong-tengwang', '穷', '《滕王阁序》', 4, 71, 'qiong.adversity',
     '老当益壮，宁移白首之心；穷且益坚，不坠青云之志。',
     'https://zh.wikisource.org/zh-hans/滕王閣序', '王勃《滕王阁序》',
     '通行正文“老当益壮”段；不采用页面后列正仓院异本',
     '老当益壮，宁移白首之心；穷且益坚，不坠青云之志。',
     '目标句相合；网页“且”附一作当异文，本地用且并去掉网页注标。全文范围含结尾诗，不将后列异本混入。'),
    ('qiong-mengzi', '穷', '《孟子·尽心上》', 2, 72, 'qiong.adversity', '穷则独善其身；达则兼善天下。',
     'https://zh.wikisource.org/zh-hans/孟子/盡心上', '《孟子·尽心上》',
     '第九章“孟子谓宋句践曰”章末', '穷则独善其身；达则兼善天下。',
     '目标句简体字相合；平台展示第九章完整问答，不是《尽心上》全篇；同key也只是既有标签，不自动宣称等义审核通过。'),
    ('yi-shishuo', '贻', '《师说》', 6, 46, 'yi.give', '余嘉其能行古道，作《师说》以贻之。',
     'https://zh.wikisource.org/zh-hans/師說', '韩愈《师说》',
     '末段“李氏子蟠”章末；页列《全唐文》卷0558／《古文观止》卷8', '余嘉其能行古道，作《师说》以贻之。',
     '目标句简体字相合；本地七段是阅读分组，不声称原刻本页码或辞书释义出处。'),
    ('yi-hezhou', '贻', '《核舟记》', 0, 48, 'yi.give', '尝贻余核舟一，盖大苏泛赤壁云。',
     'https://zh.wikisource.org/zh-hans/核舟記', '魏学洢《王叔远核舟记》',
     '首段“明有奇巧人曰王叔远”后“尝贻余核舟一”', '尝贻余核舟一，盖大苏泛赤壁云。',
     '目标句简体字相合；网页题名王叔远核舟记，平台简称核舟记且含末段。只核原句，不冒称同义已由教师认证。'),
)


def evidence_catalog() -> list[dict]:
    """Return fresh public metadata only; no database, network, or seed import."""
    result = []
    for slug, token, source, paragraph, start, sense, sentence, url, title, locator, quote, note in _SPECS:
        digest, extent, text_version = _MATERIALS[source]
        docid = str(uuid5(NAMESPACE_URL, f'wenyan:reading-document:{digest}'))
        key = f'annotation:{paragraph}:{start}:{start + len(token)}:{sense}'
        result.append({
            'id': BATCH_ID + ':' + slug, 'token': token, 'document_id': docid, 'source': source,
            'corpus_hash': digest, 'text_version': text_version, 'extent': extent,
            'paragraph_index': paragraph, 'start': start, 'end': start + len(token), 'sentence': sentence,
            'annotation_id': str(uuid5(NAMESPACE_URL, f'{docid}:{key}')), 'sense_key': sense,
            'evidence_kind': 'ORIGINAL_CONTEXT', 'catalog_status': 'CANDIDATE',
            'source_title': title, 'source_url': url, 'source_locator': locator, 'source_quote': quote,
            'source_checked_on': CHECKED_ON, 'version_note': note,
            'interpretation_source_status': 'NOT_PROVIDED',
        })
    for item in result:
        # Same surface is a navigation relation, not an equivalence judgment.
        item['related_ids'] = [other['id'] for other in result if other['token'] == item['token'] and other['id'] != item['id']]
    return result
