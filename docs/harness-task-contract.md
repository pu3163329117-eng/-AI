# DeepSeek Harness 协作任务契约

日期：2026-10-14。契约版本：`WENYAN_COLLABORATION_TASK_V1`。

本契约描述已经实现的本机 Bridge API。它不是 DeepSeek Harness 自带的 HTTP API。所有接口只接受回环地址请求，并要求 `Authorization: Bearer <本机服务令牌>`；有 `Origin` 时还必须命中配置白名单。

## 标识与状态

- `task_id` 表示一个项目协作主题；不同任务使用不同 `harness_session_id`。
- `manifest_id/version` 冻结该次运行看到的资料、来源版本和授权范围。
- `run_id` 表示一次执行尝试；同一任务可有多个 run，但全局只有一个 worker 串行执行。
- `harness_message_id` 只是 Harness 的持久入队回执，不能证明完成。
- 运行状态为 `QUEUED`、`RUNNING`、`WAITING_REVIEW`、`FAILED`、`CANCELLED` 或 `OUTCOME_UNKNOWN`。首版没有自动接受流程；模型结果始终先进入 `WAITING_REVIEW`。

## 输入契约

`POST /api/v1/collaboration/tasks` 创建任务和 manifest v1。必填字段为 `project_id`、`title`、`objective`、至少一条 `acceptance_criteria` 及至少一个 `context_items`。每个上下文项必须声明：

```json
{
  "layer": "project_baseline",
  "source_id": "docs/development-plan.md",
  "source_version": "sha256:...",
  "classification": "project_non_sensitive",
  "content": "发送给协作运行时的最小片段"
}
```

`layer` 只允许 `project_baseline/current_task/session_summary/evidence`；`classification` 首版只允许 `synthetic/project_non_sensitive`。绝对路径、父目录跳转和 `.env` 路径不能用作 `source_id`。Bridge 不会按 `source_id` 读取文件，它只是可追溯标识；真正发送的只有调用方明确放入 `content` 的文字。

`POST /tasks/{task_id}/context-manifests` 用 `expected_current_version` 建立下一版清单。它要求 `Idempotency-Key` 和 CAS 版本；旧成果随即显示 `needs_revalidation: true`。新 run 不允许引用旧清单，已排队的 run 仍保留创建时的冻结版本。

`POST /tasks/{task_id}/runs` 明确派发一次执行：

```json
{
  "prompt": "只审查这份合成契约并列出风险",
  "manifest_version": 1,
  "max_output_tokens": 2048,
  "timeout_seconds": 120
}
```

请求必须携带 `Idempotency-Key`。同键同载荷返回原 run；同键不同载荷返回 `IDEMPOTENCY_KEY_REUSED`。额度是 Bridge 的单次本地限制，不等于厂商账户级硬预算。

`POST /tasks/{task_id}/messages` 追加同任务追问并创建后续 run。若已有活动执行，追问保持 `QUEUED`，不会并发注入当前轮。mock 沿用任务 session 标识；stdio 每个 run 使用新的 Harness session 和独占目录，通过 Bridge 重建同任务、同 manifest 的已完成请求与候选回答。native session restore 标为未验证，旧版本及未确认轮次不自动重放。

## 输出与完成边界

`GET /runs/{run_id}` 返回状态、固定输入清单版本、限制、Harness 标识和候选 artifacts。stdio 必须关联入队 messageId、其 user event、对应 turn 的 assistant 文本与 completed turn/end，并观察目标 session running/idle，才写入 WAITING_REVIEW。通知允许先于回执；只入队、缺 turn/end 或其他 session/子任务文字不能证明完成。只保存可见 text，不保存 reasoning/raw stream。

`GET /runs/{run_id}/events` 返回有限 SSE 快照。用 `Last-Event-ID` 或 `after_sequence` 读取后续事件；重连只读数据库，不会重发模型请求。

`POST /runs/{run_id}/cancel` 对 QUEUED run 直接取消；对 RUNNING run 设置取消标志并只终止 Bridge 登记的专属子进程。本机协议没有单会话取消，取消不承诺云端已停止计算或不计费。

`GET /tasks/{task_id}/handoff` 返回任务、所有 manifest、消息、run、候选成果、结构化 audit events 及验证声明。模型文字不能自行变成项目事实、权限、教师审核或发布收据。

## 错误与恢复

- 请求可能已经发送而 stdio 断开、超时或 Bridge 意外退出：`OUTCOME_UNKNOWN`，禁止自动重发。
- Bridge 重启时，遗留 `RUNNING` 一律转为 `OUTCOME_UNKNOWN`；`QUEUED` 保留并继续串行处理。
- 认证、Origin、manifest 版本、幂等键或预算校验失败时，不派发运行时请求。
- 原始异常不回显环境变量或密钥；审计只保存诊断码、摘要、版本和有限事件元数据。
