# AI 理由反馈课程对照与校准准备

日期：2026-10-08。承接本机 DeepSeek 影子试用。本轮交付**离线校准工具与待教研审核的样例**，不是已完成模型语义验收，也不发布正式学生评分。

## 交付

- `backend/ai/calibration_cases.py`：40 个合成对照样例，覆盖从、归、去、属、坐、穷、假、贻的 16 个 CORE / TRANSFER 场景。每个场景含合理推断与“结论正确但理由错误”的一对样例；另含只重复答案、单字片段不足、注家解释越界、虚构证据及两种材料指令攻击。
- 每例包含课程关系量表、最小输入、开发预期、所需引用与量表要素、核对说明。样例和量表都标为 `NOT_VERIFIED`；没有虚构审核人或签署时间。
- `backend/ai/calibration.py`：离线比较已记录候选；共用学生影子服务的封闭 Schema、引用 ID 检查和低置信度弃答逻辑。记录必须匹配套件、输入摘要、提示和 Schema 版本，不匹配就拒绝整批比较。
- `backend/scripts/ai_reason_calibration.py`：清点、导出最小合成输入、脚本自检、比较记录文件。**没有 `--live` 选项，不加载设置或 Key、不联网、不读写学习数据库。**
- [教研核对工作单](ai-reason-review-workbook.md)：供实际教师逐项检查原文范围、推断关系、可接受的替代解释和错误边界。

样例原文来自仓库已有课程与资料，依据见 [来源清单](material-sources.md)；本轮没有重新完成原典校勘或注释审核。训练运行中的教师量表仍是 `reason-preview-v1` 通用试用量表，没有被这批开发草稿替换。已有会话、积分、正式等级、旧反馈与审核记录不重算。

## 命令

在项目根目录运行：

```powershell
# 只清点：NOT_RUN，external_call_attempted=false
python -m backend.scripts.ai_reason_calibration

# 用明确的模拟响应验证工具链，不测模型准确率
python -m backend.scripts.ai_reason_calibration --self-test

# 输出合成最小输入及摘要，没有开发预期标签
python -m backend.scripts.ai_reason_calibration --export-inputs

# 离线比较操作人准备的版本绑定记录；不会自动重试或调用模型
python -m backend.scripts.ai_reason_calibration --responses data/ai-calibration.local.json
```

输入导出包含多个 `cases`；未来调用模型时**只能发送单例的 `payload`**，不要发送案例名称、`kind`、开发预期、对照记录或整个导出文件。课程专属关系量表是受控教学依据；开发预期判断仅供本地比对，不能作为学生理由的一部分送给评价器。

旧 `ai_shadow_review --live` 是独立的付费入口，不是本工具的默认动作。批量真实联调需要另行明确样例、调用次数和费用边界；本轮没有运行该入口。

## 记录文件

从清点／导出结果取当前套件摘要、提示版本与 Schema 版本；从单例取 `case_id`、`input_digest`。记录示意如下，摘要占位值不能直接运行：

```json
{
  "suite_version": "reason-calibration-draft-v1",
  "suite_digest": "从当前导出取64位摘要",
  "prompt_version": "feedback-prompts-v1",
  "schema_version": "feedback-v1",
  "origin": "RECORDED_UNVERIFIED",
  "responses": [
    {
      "case_id": "cong-core-supported",
      "input_digest": "从此单例导出取64位摘要",
      "status": "OK",
      "error_code": null,
      "raw_output": "保存的结构化评价JSON文本",
      "attempts": 1
    }
  ]
}
```

记录 `raw_output` 是 JSON 字符串，字段必须符合 `EvaluatorOutput`。已有影子 CLI 的 `output` 对象需序列化为该字符串。降级记录使用 `status=FALLBACK`、已知 `error_code`、`raw_output=null` 及实际尝试数。明显指令攻击的预期是发送前阻断，因此只有 `SAFETY_BLOCKED` 且尝试数 0 才符合该开发边界。

记录来源是操作人声明，**不是认证过的供应商调用证据**；文件中的“成功”不能证明来自真实模型。缺失、重复、未知 ID、版本不符、额外字段、布尔冒充尝试数、重复 JSON 键及非有限数均明确处理。批次文件不超过 2 MB，单个候选沿用 32 KB 上限。错误日志不回显原文、理由、密钥、路径或原始模型内容。

## 指标口径

| 指标 | 含义与限制 |
| --- | --- |
| 有效候选覆盖 | 通过结构校验的候选／38 个非攻击样例；缺失、降级、结构失败不能隐藏 |
| 开发标签一致率 | 有效候选的标签与开发草稿预期一致；不是教师金标准确率 |
| 开发误接受 | 非弃答的负例中，被标为 CORRECT_REASONING 的比例 |
| 开发误拒绝 | 非弃答的正例中，未标为 CORRECT_REASONING 的比例 |
| 正例弃答率 | 正例中的 UNSCORABLE 单独统计，避免将全部弃答说成零误拒绝 |
| 引用 ID 合法性 | 原始候选非空引用列表的 ID 是否已提供；不是引用语义正确率，空列表不算成功引用 |
| 开发证据／要素匹配 | 与草稿的 required_evidence / required_criteria 对照；例如正确标签但只命中 cite，不能算该完整正例通过 |
| 语义引用正确率 | 本轮为 null，需要教师检查所引线索真的支持推断 |

指标同时返回分子、分母和比例；分母为 0 时比例为 null，不编造 0 或 100%。结构失败不被计为有效评价，另列失败数和覆盖缺口；部分记录只能反映已记录样例，不能推断全套质量。

模拟自检故意返回 `metrics=null`，防止把“脚本按预期返回”当成真实 AI 准确率。即便全部样例与开发预期一致，仍保持：

```json
{
  "review_status": "NOT_VERIFIED",
  "semantic_accuracy_verified": false,
  "may_update_learning": false,
  "live_ai_release_gate_satisfied": false
}
```

## 教师审核与真实模型比较

1. 实际教师核对全部样例及量表，特别是“天下归仁”的注家版本、片段是否足以判断、施受关系和合理替代推断。需要修订时升版本，旧摘要记录不能混评。
2. 冻结审核后的开发集与独立保留集；本轮 40 个公开开发样例不能同时充当调提示数据与发布考试。未来还需真实去标识学习样本和人工双评／分歧处理。
3. 获得明确调用预算后，小批量真实 DeepSeek 影子比较，观察误接受、误拒绝、弃答、引用与安全失败。记录失败样例，不能只挑成功的输出。
4. 再比较提示或课程量表候选。未取得实测证据前，本轮不修改运行提示，也不宣称质量提高。
5. 一般学生发布仍需要鉴权、配额、真实语义与安全审核；正式等级继续按独立评测审核与校准处理。

## 验证

后续离线稳定性精磨已修复降级前重复引用校验和无法评分的建议一致性；新增十轮异常矩阵、缓存／并发与记录绑定验收。最新后端 468 项、前端 88 项及构建通过，详细口径见 [离线稳定性验收](ai-offline-qualification-20261008.md)。以下为校准工具首次交付时的记录。

新增离线专项测试 38 项通过；全量后端回归 449 项通过。模拟工具链 40 / 40 符合脚本预期，原安全契约样例 12 / 12 通过。模拟结果不是 DeepSeek 语义质量分数；两种已知材料指令攻击只验证当前阻断路径，不代表完整安全验收。
