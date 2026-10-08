# DeepSeek 接入与影子联调

日期：2026-10-08。用户已明确选择 DeepSeek，并同意发送原文片段、学生理由与结论、评分量表，不发送昵称、档案 ID 或其他学习记录。该许可不等于正式定级、自动评分写库或教研认证；本轮继续保持这些边界。

## 本轮交付与状态

- 已实现 `DeepSeekProvider` 真实 HTTP 适配器，固定官方 HTTPS 地址，无任意 URL、工具调用、文件上传、跳转跟随或环境代理转发。异步客户端使用项目现有 `httpx2==2.13.1`，已移入生产依赖。
- 根据 [官方对话接口](https://api-docs.deepseek.com/api/create-chat-completion/) 使用 `deepseek-flash`、关闭 thinking、JSON 输出和显式 token 限额。可在后端配置官方文档列出的 `deepseek-v4-pro`，不自动迁移模型。
- 根据 [JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/) 将本地 Schema 放入系统提示，随后仍执行本地 Schema 和引用校验；JSON 模式不等于字段、语义正确，也可能返回空内容。
- 统一处理厂商限流、网络超时、鉴权／余额／服务异常，不回显厂商错误响应。HTTP 状态依据 [官方错误码](https://api-docs.deepseek.com/quick_start/error_codes/)；401、402 等当前统一呈现为 `PROVIDER_UNAVAILABLE`，需在控制台检查凭证、余额等。
- 新增后端配置加载、独立 `ai_shadow_review` 命令，以及只读状态中的“密钥已配置／影子联调可用／学生反馈未开放”三个独立标志。
- 敏感模式检测会阻断常见手机号、邮箱、身份证号和凭证样式，输入 Schema 排除结构化昵称、档案 ID 等。正则不能保证识别所有个人信息，理由和量表中仍不要填写个人资料。

**当前本机没有 DeepSeek 密钥，也没有执行真实付费请求。** 本轮 HTTP 测试全部使用 MockTransport；不将模拟 HTTP 通过写成真实模型或语义质量验收。学生端没有新增付费调用入口。

## 本机配置

1. 将 `backend/.env.example` 复制为 `backend/.env`，该文件被 Git 忽略。不要覆盖已有 `.env`；已有文件只补下列四项。
2. 在本机编辑器填写，不把 Key 发到聊天、前端、源码或共享截图：

```dotenv
WENYAN_AI_ENABLED=1
WENYAN_AI_DATA_POLICY=minimal_learning
WENYAN_AI_MODEL=deepseek-flash
DEEPSEEK_API_KEY=在本机填写实际密钥
```

本机 `backend/.env` 只加载 AI 白名单字段，字面读取，不执行变量展开、命令或 `export`；操作系统同名变量优先。示例里的数据库变量并不会因此被自动加载或修改，继续沿用原数据库启动方式。

只允许合成数据时改为 `WENYAN_AI_DATA_POLICY=synthetic_only`。默认启用开关为关闭。密钥来源：[DeepSeek 控制台](https://platform.deepseek.com/api_keys)。现有密钥即可，不要求创建或充值；实际权限及余额以自己的账户为准。

## 一次人工触发的联调

项目根目录运行：

```powershell
# 缺省不发外部请求，返回明确的未调用／降级状态，不是假 AI 成功。
python -m backend.scripts.ai_shadow_review

# 明确允许一次付费影子评价，默认只有内置合成样例。
python -m backend.scripts.ai_shadow_review --live

# 自己准备的最小化样例，放在不上传的 data 目录。
python -m backend.scripts.ai_shadow_review --live --case data/ai-case.local.json
```

单个样例格式：

```json
{
  "task": "evaluator",
  "data_kind": "minimal_learning",
  "payload": {
    "stage": "CORE",
    "text_version": "你实际使用的冻结材料版本",
    "target": "从",
    "visible_evidence": [{"id": "e1", "text": "为执经讲解"}],
    "student_reason": "联系人物和讲解行为解释自己的判断。",
    "student_conclusion": "跟从求教",
    "rubric": [{"id": "r1", "criterion": "在这里填写实际核验的评分依据；示例不是已审量表。"}]
  },
  "answer_aliases": []
}
```

样例 `data_kind` 是操作人的声明，不能自动证明材料已去标识或量表已审核。实质语义评价须使用实际核验的量表，当前输出始终标为 `rubric_review_status=NOT_VERIFIED`，仅供影子比对。Teacher 样例必须提供本地标准答案别名，它不送入模型教学消息。三组输入的具体约束见 `backend/ai/contracts.py`。

没有 `--live`、未启用、缺密钥、未授权的数据类型或不合法输入都不能发送请求。只有 `status=OK` 且 `external_call_attempted=true` 才表示实际适配器得到并校验了响应；这仍不能代表 AI 判断正确。CLI 非成功返回非零退出码，错误响应不伪装成成功。

输出是操作人本机终端中的**影子候选**，不要共享含反馈内容的终端截图；不会读取数据库、创建学习会话、追加观测或修改已有证据链。它不是学生界面的“已复核”，不影响完成状态、能力等级或积分。

## 开销与超时边界

- 每次 HTTP 请求最多 768 输出 tokens；包含 Schema 的请求体和响应体各不超过 32 KB。
- 单次服务调用总期限沿用 4 秒，最多一次结构修复，即最多两次 HTTP 请求；限流、超时和安全失败不自动重试。
- Provider **实例内**限制每分钟 5 次、每小时 20 次；请求开始即占额度，包括修复和失败。重启或新建实例会重置，CLI 每次运行只限制本次两次请求。
- 这些是调用量和 token 控制，**不是账户级人民币预算或账单硬上限**。调用可能产生 API 费用；本地取消或超时也不保证服务端停止计算或免扣费。账户预算、用量和计价应在控制台另行管理，见 [官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)。

## 验证与下一步

全量回归：后端 379 项、前端 82 项通过；新增 DeepSeek／配置专项 36 项。测试涵盖真实请求构造、外部开关、最小数据类型、HTTP 状态映射、跳转阻断、厂商错误去敏、空或截断响应、工具拒绝、输入／响应体上限、敏感模式、实例调用配额和配置读取。第一次运行遇到 Windows 沙箱临时目录权限错误，改用明确隔离的项目 output 新目录后完成全量测试，没有放宽生产安全策略。

本轮不改前端页面，不把上轮的布局和截图当作本轮新验收。数据库无新表或迁移，备份为本机 `output/backups/wenyan-before-deepseek-adapter-20261008.db`，不上传仓库。

API 已在本地重新加载，8000 直连与 5173 代理读取状态一致：配置有效、密钥未配置、影子调用不可用、学生调用关闭。数据库 `integrity_check=ok`，升级前 24 张表的所有原有行指纹不变，没有改写旧训练、测评、积分或审核记录。

下一步：本机配置 Key 后先进行一次合成样例真实联调，再用人工核验的开放理由集做影子比较，检验替代推理、错误误接受、泄漏和低置信度。评测达到发布门槛后再接学生侧理由反馈。正式定级、自动写掌握值和生产认证仍不随模型接入解锁。
