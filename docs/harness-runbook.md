# DeepSeek Harness 协作 Bridge 运行手册

2026-10-15 当前停止点：四次后端合成预算已耗尽（4/4、0 重试）。最后一次经用户批准改为短输出，真实返回“乙”（694 输入/1 输出 token），保存 CANDIDATE；无密钥重启读取、SSE、handoff、幂等和预算拒绝通过，最终 655 项测试通过。旧锁和预算不可重置，禁止重跑任何 execute 验收命令；8000 仍为 mock，3080/学习数据不变。真实追问与运行取消尚未验证，不能称完整真实闭环通过。详见 [当前验收记录](harness-backend-integration-20261015.md)。下面额度/测试数字为历史记录。

日期：2026-10-14。默认配置为关闭；下面首先启动不产生模型费用的 mock 模式。

2026-10-15 续接最新状态：用户确认用原剩余 3 次调整验收角色后，continuation permit 已绑定原锁并复用同一账本。只再尝试了一个全新任务，收到 4 个上游保活注释后再次超时，当前累计 2/4 次、另 2 次未用、0 重试。原 policy/锁/未知任务保持不变，两条真实记录的无密钥读取恢复通过。最终后端全量 636 项通过，但真实成功追问及运行取消仍未验证；不要重跑 `harness_backend_continue --execute-approved-remaining-three`，其独占启动标记保留且预算不能重置。

2026-10-15 后端接入更新：真实 controller 路径现需额外设置 `WENYAN_COLLABORATION_BUDGET_POLICY_PATH`，只接受冻结的四场景合成 permit，默认不会生成 permit 或借用个人凭证。本轮用户另行批准的 4 次预算实际只尝试 1 次，HTTP 200 后超时并保留 OUTCOME_UNKNOWN，未重试；其余调用暂停，不能运行同一验收器绕过发送锁。假传输 HTTP 全闭环与后端 629 项回归通过，真实超时记录的无密钥重启读取通过；8000 仍保持 mock，详见 [后端接入验收](harness-backend-integration-20261015.md)。

2026-10-14 本机运行状态更新：已按用户要求正常重启 8000 并启用 mock，实际 HTTP 创建/追问/结果/取消/正常重启恢复及隔离异常退出恢复均通过。3080 保留，25 张学习库表的行数及完整行指纹一致；见 [本机 HTTP 验收](harness-http-acceptance-20261014.md)。默认源码配置仍为关闭，当前进程配置为开启 mock。

## 启动模拟闭环

stdio 离线加固已完成，后端全量曾 583 项通过；新增发送保护和管道清理回归后协作专项为 86 项通过。Shell、自动重试、原生 JSONL 日志及供应商附加会话/插件上传均关闭。最小真实合成包已经单独批准并成功调用一次：输出 26 token、3.057 秒、预期候选匹配。该次预算已用完，HTTP 后端继续 mock。见 [单次真实验证](harness-real-synthetic-20261014.md)。

在新的 PowerShell 窗口为当前后端进程设置环境变量。令牌使用至少 24 个不含空白的 ASCII 字符，不要写进仓库或聊天记录。

```powershell
$env:WENYAN_COLLABORATION_ENABLED = '1'
$env:WENYAN_COLLABORATION_RUNTIME = 'mock'
$env:WENYAN_COLLABORATION_TOKEN = '<本机随机服务令牌>'
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

若 8000 已有项目后端，先在原窗口正常停止它再重启加载新代码；不要同时启动第二个占用同端口的实例。Bridge 会创建独立 `data/collaboration.db`，不会迁移或写入 `data/wenyan.db`。

调用时统一带：

```text
Authorization: Bearer <本机随机服务令牌>
Origin: http://127.0.0.1:5173
Idempotency-Key: <每个写请求稳定且唯一的标识>
```

任务、清单、run、追问、状态、SSE、取消及 handoff 的请求格式见 [任务契约](harness-task-contract.md)。

## 停止

在运行 uvicorn 的窗口按 `Ctrl+C`。worker 会停止接受新任务并等待当前线程的有限退出时间。普通停止不删除协作库或候选结果。不要使用按名称批量终止 Node/Python 的命令；真实模式的取消只由 Bridge 终止自己登记的子进程。

本轮后台进程有独占隐藏控制台。可先用 `netstat -ano` 和进程命令行核对 8000 的 PID，再执行 `python -m backend.scripts.collaboration_local_control <确认的后端PID>` 正常发送 Ctrl+C。辅助程序仅在该 PID 与自身是控制台唯一成员时发送信号，共用控制台会拒绝；没有强制结束的后备路径。

可复用验收器：在 8000 正常停止且 8001 空闲时，先用 `editorial_data_audit backup` 生成新的学习库备份，再运行 `python -m backend.scripts.collaboration_http_acceptance --backup <该备份路径>`。它以随机内存令牌启动 mock 后端、执行 HTTP 验收、留下 JSON 报告，并保持 8000 运行。异常退出测试仅对自建的 8001 模拟子进程注入故障，学习数据库为内存。报告目录会保存合成测试库和日志，不适合提交或上传。令牌不输出、不落盘；以后手工调用接口时，请使用自己通过进程环境配置的令牌启动后端。

## 身份与数据访问

- 服务必须绑定 `127.0.0.1`；接口还会检查 URL host、Bearer token 和 Origin。
- token、模型密钥只放进启动进程环境；Bridge 不读取 `backend/.env` 获取协作配置。
- 默认协作库为 `data/collaboration.db`；若设置 `WENYAN_COLLABORATION_DATABASE_URL`，仍必须是独立 SQLite 文件，不能等于学习库。
- 模拟模式只返回带 `synthetic: true` 的确定性候选结果，不启动 Node 或调用模型。

## 任务、权限与预算

任务内容上限由 `max_context_bytes` 控制，默认 128,000 字节；超过即拒绝，不静默截断。每个 run 另有 `max_output_tokens` 与 `timeout_seconds`，全局上限由 `WENYAN_COLLABORATION_MAX_TOKENS` 和 `WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS` 控制。

首版 profile 禁止 Shell、任意文件、MCP、发布、审批和学习库访问。预算字段只限制 Bridge 发出的单次请求，不保证供应商账户绝对封顶。真实模式前必须另外确认：资料类别、合成任务内容、模型/provider、单次及总预算。

## 恢复规则

- 重启后 QUEUED run 继续执行；遗留 RUNNING 改为 `OUTCOME_UNKNOWN`，不会自动重发。
- SSE 断线用最后事件序号恢复；恢复只读审计表，不创建新 run。
- 同一幂等键与同一载荷可安全重取；键相同而载荷不同会冲突。
- `OUTCOME_UNKNOWN` 先核对 Bridge 事件、候选结果及厂商账单，再由人决定是否用新幂等键重新派发。当前受限 profile 的原生 JSONL 持久化关闭，不依靠 Harness session 日志恢复。
- manifest 更新使用 `expected_current_version`；冲突时重新读取 handoff，不覆盖新版本。

## 真实 stdio 模式（更多调用需要另行授权）

代码已锁定本机 `@deepseek-ai/dsh` 0.2.0-rc.2 的 initialize/session/prompt/shutdown 协议。home/workspace 必须在项目 data 下，每个 run 使用独占 UUID 子目录，不复用已有运行目录。profile 不暴露 Shell/MCP，自动重试与原生 JSONL 持久化关闭。完成要求 messageId 关联的具体 turn 成功结束、可见文本与根 session running/idle。历史来自 Bridge 显式重建，不凭 session ID 声称原生恢复成功。

真实模式需要同时设置 `WENYAN_COLLABORATION_RUNTIME=dsh-stdio` 和 `WENYAN_COLLABORATION_REAL_CALLS_ENABLED=1`，还需要进程环境中的模型密钥。这里不提供可直接复制的启用命令：用户另行批准的首次最小合成联调已完成且预算已用完，不授权把运行中的 HTTP Bridge 切到真实模式或继续付费调用。`output/harness-real-synthetic-20261014/model-attempt.json` 是单次防重复锁，成功或失败后均不可删除重置来绕过限制。更多真实调用仍需明确批准资料范围和预算。

## 已验证与待确认

已自动验证：模拟任务/追问/结果闭环、幂等冲突、manifest CAS 与旧成果失效、跨任务隔离、排队及运行取消、重启恢复、独立六表协作库、Bearer/Origin 拒绝、SSE 游标、路径型 source ID 拒绝；Windows 上固定版本 profile 的有效配置转储成功，`persistent-bash` 与 `persistent-pwsh` 均为 `disabled: true`。

本次单轮已确认：真实 DSH 握手/完成事件、deepseek-official/deepseek-flash 路由、最小合成输入、正常 shutdown 及供应商 usage（588 输入/26 输出 token）。待确认：厂商账单、成熟费用计量、真实追问/取消/恢复、异常终止后的厂商行为及操作系统级强沙箱。未确认项不得写成测试通过。
