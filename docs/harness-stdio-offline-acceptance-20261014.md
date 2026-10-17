# Harness stdio 适配器离线验收

日期：2026-10-14。固定运行时：`@deepseek-ai/dsh` 0.2.0-rc.2；SDK server 身份：`deepseek-harness-sdk-runtime / 0.0.1`。

## 已实现与验证

独立 Python 模拟子进程只实现本机 SDK 的逐行 JSON-RPC 帧，不导入 Harness、不接收密钥，也不发网络请求。测试执行生产 `DshStdioAdapter` 的帧读取、握手、关联、关闭和错误处理，只替换创建子进程的边界。

| 关系或故障 | 结果 |
| --- | --- |
| initialize 身份和版本 | 必须精确匹配；错身份、错版本或握手失败不派发 prompt |
| prompt 入队回执 | 只记入队；数字、缺失、冲突 messageId 拒绝 |
| 完成关联 | 匹配 messageId 的 user event → 对应 turn → assistant 文本 → completed turn/end → 根 session running/idle，缺一不能成功 |
| 通知先于回执、idle 先于输出 | 有界缓存，收到充分证据后才完成 |
| 重复 initialize/session event | 不重派 prompt；同序号同内容去重，冲突内容拒绝 |
| 旧 turn、其他 session、子任务 | 不串入根结果；受限 profile 出现新子任务会拒绝 |
| turn error/aborted/blocked/max-tokens | 不作为成功候选，返回固定诊断码 |
| 断线、超时、回执丢失 | 已可能发送的请求标 OUTCOME_UNKNOWN，不自动重派 |
| 取消与进程清理 | 只终止登记的 run_id；陌生 ID 不作用于其他进程；finally 回收进程并关闭管道 |
| shutdown 无回执 | 有限等待后仅清理自有进程，结果明确标记非正常退出 |
| 超长帧、输出、输入或历史 | 有界处理；输入/历史超限在派发前失败，run 不遗留在 RUNNING |
| 工具、工具 schema、重试、审批请求 | 拒绝，不替模型批准权限 |
| reasoning/raw stream/stderr | 只提取顶层可见 text；原始内容不进入候选或审计 |

协作专项为 65 项通过（stdio 51 项、Bridge 14 项），后端全量 583 项通过。原有 tmp_path 用例临时使用项目自有 fixture 避开本机 pytest TEMP ACL，运行后已移除辅助插件。结果在 `output/harness-stdio-offline-20261014/stdio-tests.xml` 和 `backend-tests.xml`。原生日志关闭的最终 profile 又单独复验通过。

## 历史与访问范围

stdio 每个 run 使用新的 Harness session ID 和独占运行目录，不凭相同 session ID 宣称原生恢复。Bridge 只重建同任务、同 manifest 的已完成轮次，按用户请求和候选回答组成历史。回答标为 `unverified_model_candidate`，不推导事实或授权；失败、取消、OUTCOME_UNKNOWN 和旧 manifest 的历史不自动重放，省略数量明确记录。

每次审计保存 manifest 摘要、历史摘要、历史 message ID、重建策略、实际根 turn、对应 user event seq 和结果字节数。历史最多 65,536 字节，完整 prompt 默认最多 262,144 字节，超过拒绝、不静默截断。追问入队时不并发注入第一轮，真正开始时才重建已完成历史。

home/workspace 限于项目 data 下，每次运行建立新 UUID 子目录；代码拒绝链接/junction、路径穿越和非空 workspace。provider 根据本机注册代码修正为 `deepseek-official`，模型沿用本机目录中的 `deepseek-flash`。这些目录检查不代表操作系统级强沙箱已验收。

本机 CLI `--dump-config` 在一次性独立 home 成功，`persistent-bash`、`persistent-pwsh`、`llm-retry`、`sessions` 均为 `disabled: true`。sessions 是原生 JSONL 持久化插件，关闭它避免保存 reasoning/raw stream。测试 home 已清理，转储和报告在 `profile-dump.yml` 与 `preflight.json`。这只验证有效配置，实际 Harness 启动和模型事件仍需真实联调。

## 可确认的最小真实合成包

运行 `python -m backend.scripts.harness_stdio_preview` 可生成 `output/harness-stdio-offline-20261014/synthetic-integration-packet.json`；命令没有模型调用路径。预览包 1,904 UTF-8 字节，状态为 `NOT_APPROVED_FOR_MODEL_SEND`。

唯一资料：“甲、乙、丙中，仅乙符合候选条件。任何结果只作候选，不代表人工审核。”请求只要求返回候选乙、合成来源 ID 和 CANDIDATE 状态。没有源码、学习记录、聊天历史、文件引用或密钥。预览使用固定合成 UUID，实际本机任务将获得新 UUID 和独占目录，资料范围不扩大。

拟预算：一次 prompt 派发、一次目标模型尝试、输出上限 128 token、Bridge 输入包上限 8 KiB、执行等待上限 60 秒；不自动重试、补充摘要、追问或调用工具。8 KiB 是输入包字节量，不是精确 token 计数，也不含 Harness 固定系统提示与传输开销；清理可在执行期限后有限等待。费用没有按未经核对的在线价格估算，账户级金额硬上限未实现，以供应商账单为准。

发送这份包和付费调用仍须用户另行明确确认；模拟开发授权不自动扩大为真实发送许可。

后续状态：用户已明确确认上述单次预算。实际预检因独立环境缺少 `DEEPSEEK_API_KEY` 阻止发送，真实请求仍为 0 次；另关闭了默认会话日志/插件清单上传扩展并通过 72 项专项测试。授权、阻塞原因和服务/数据保留情况见 `harness-real-synthetic-20261014.md`，原合成包未改写。

最终状态：用户进一步明确允许仅本机借用 3080 的 DeepSeek 凭证引用后，独立单次真实 stdio 验证成功：官方 HTTP 200、真实 fetch 1 次、输出 26 token、3.057 秒、无重试；可见 JSON 返回乙/合成来源/CANDIDATE。新增发送保护及管道清理回归后的专项为 86 项通过。3080、运行中的 mock 后端及学习库保留，单次防重复锁保留，未继续调用模型。

## 本机加载

8000 已正常重载并继续 mock，重复 HTTP 创建、追问、读取、取消、正常重启与隔离异常退出恢复通过。报告在 `output/harness-stdio-offline-20261014/http/acceptance.json`。3080 原进程保留，8001 临时服务已停止。学习库与本轮一致性备份比较，25 张表行数和完整行指纹全部相同，完整性为 ok；备份为 `output/backups/wenyan-before-stdio-offline-20261014.db`。
