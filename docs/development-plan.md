# 文言 AI 学习智能体：合并执行计划

更新：2026-10-06。依据《文言文 AI 学习智能体 V1.0 工程规格》、录音整理和新增“原文全文点读，词—句—段—篇—时代五层语境”要求。

## 产品与架构边界

真实全栈项目：React / TypeScript → FastAPI → SQLAlchemy / SQLite。训练状态由后端领域层决定，前端只提交学习意图并渲染快照。教研资料是数据，不是可执行指令。保留黑白阅读界面和手机端支持。

学习闭环保持“暂放 → 获取新语境 → 回溯 → 证据与判断 → 陌生文迁移”。展示原文不等于展示完整翻译；扩大语境不自动选择答案、认定证据、发积分或跳过迁移。

## 当前迭代：语境阅读接入训练闭环

| 工作 | 实现与验收 |
| --- | --- |
| 后端领域命令 | REQUEST_MORE_CONTEXT 校验冻结原文定位，生成五层语境选择；不改变解题进度。REVISIT_VARIABLE 要求此前暂放并清除暂放标记。 |
| 前端原文点读 | 字词点击、词组起止选择、五层标尺切换；请求成功后以服务端定位为准。失败不把未保存选择显示为已保存。 |
| 保存与恢复 | 会话快照保存词、段落、码点位置和 scope；浏览器保存会话引用，刷新 GET 恢复。旧会话保留原文版本，迁移切换清空原文选择。 |
| 正文排版 | 阅读栏使用容器宽度决定双栏或上下排列，避免侧栏挤压正文；重复目标词不截断题干；字词及标尺支持键盘。 |
| 教研内容约束 | reading_context 在编辑、发布时校验；区分 FULL / CHAPTER / EXCERPT / PROMPT，不能把节选冒充全文。岳阳楼记补齐六段；其余待校订资料显示节选或题目原文。 |
| 回归 | 单元/API 测试验证 Unicode、同词多处定位、句界、五层状态保持、非法请求无副作用、事件、幂等、版本冲突、版本冻结；实际浏览器检查点读、刷新、暂放回看与响应式布局。 |

### 接口与数据约定

沿用 `POST /api/v1/training/sessions/{session_id}/commands`，必须携带 `Idempotency-Key` 和 `expected_state_version`。

```json
{
  "type": "REQUEST_MORE_CONTEXT",
  "expected_state_version": 1,
  "payload": {
    "paragraph_index": 0,
    "start": 1,
    "end": 2,
    "scope": "SENTENCE"
  }
}
```

位置使用 **Unicode 码点**，段号从 0 开始，`[start,end)`；不能使用 JavaScript UTF-16 下标直接传给后端。前端统一以 `Array.from` 计算。最多选择同段 80 个码点，拒绝空白/纯标点及越界请求。句界按 `。！？`，分号保持句内语境。

`context_selection` 保存 `paragraph_index/start/end/token/sentence/paragraph/scope`。scope 为 WORD / SENTENCE / PARAGRAPH / WORK / ERA。事件 `training.context_expanded` 只记录位置、token、scope、stage，不复制整篇原文。

`reading_context` 保存段落、作者、时代、篇章说明、材料范围、资料版本、可选原文链接和教研词组。CORE 与 TRANSFER 在创建会话时同时冻结。编辑新版本不覆盖已开始的训练；只有新建会话使用新的语境资料。

### 材料范围与校勘

《岳阳楼记》原文参考 [维基文库](https://zh.wikisource.org/zh-hans/岳陽樓記)，简体和教学标点采用当前题干一致的“淫 / 曜 / 乎”异文，版本字段明示。其余课内资料仍须逐篇校勘、補全文、登记来源；当前的节选标识是诚实的过渡状态，不代表全文内容任务已经全部完成。

已知后续内容风险：“坐盗”素材题源与《唐雎不辱使命》不一致，需要教研修订为《晏子春秋》相关章节并重新审核词义，不能只补周边文字后宣称校勘完成。参考 [原典](https://ctext.org/yanzi-chun-qiu/chu-wang-yu-ru-yan-zi/zhs)。

## 后续次序：遵循总指南，不以页面数量代替完成度

1. **P0 内容质量**：完整原文和 Source / Review / Version 数据；逐篇补齐、题源校勘、词组与时代背景；形成可发布教研审核流程。已有快照不做静默改写。
2. **P0 推理表达**：从当前选证据、选词义扩展到稳定 span 标注、ReasoningGraph 最小结构、可复核的解释；补充开放判断验收用例。
3. **P0 AI 能力**：实现总指南的模型 Provider 接口、结构化输出、提示防泄漏与评测集，再接入真实模型。当前规则式判题 Demo 不等同于已经完成 AI 智能体。
4. **P0 运行安全**：账号鉴权、教研接口权限、数据备份/迁移、生产持久数据库、部署与跨设备恢复。当前本地内容管理无鉴权，不应暴露公网。
5. **P1 体验深化**：已有日任务、专题练习、错题与复习、报告及成就继续以真实学习数据验证；补多题型、难度分层和题库。随机选项已有实现，须持续回归正确率与会话内排序稳定性。

## 分工与验证命令

本轮主分支负责前端、阅读资料与集成；后端协作分支负责领域命令与 schema；QA 协作分支负责定位、持久化和教研资料回归。文件所有权分开，集成后统一验证。

```powershell
python -m pytest backend/tests -q -p no:cacheprovider
Set-Location frontend
npm run build
```

本地预览 `http://127.0.0.1:5173/`，API `http://127.0.0.1:8000/api/health`。局域网只能分享当前机器实际内网 IP 的 5173 端口，API 保持回环监听，不能把可访问公网域名当作本地验证结果。

发布仅同步本轮源代码和文档到 `output/source-release` 的 GitHub 仓库；不上传本地 SQLite、日志、浏览器截图、缓存、凭证或旧根仓库内容。
