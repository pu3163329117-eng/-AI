# Harness 后端接入：实现完成，真实闭环部分验证

日期：2026-10-15。真实 HTTP 首请求在收到供应商 200 后等待超时，状态为 `OUTCOME_UNKNOWN / DSH_RUN_TIMEOUT`。已停止且没有重试，不能把假传输通过写成真实全闭环通过。

最新（最后一次短输出验证）：用户批准将最后 1 次改为短合成指令，仍限 128 token/180 秒、无重试，并仅在本机借用原凭证。真实输出恰好为 **乙**，供应商回报 **694 输入 / 1 输出 token**，HTTP 200、完成标记已见、SSE 解析失败 0；后端约 3 秒完成为 **WAITING_REVIEW / RESULT_REQUIRES_REVIEW**，候选 **CANDIDATE** 已保存，未审批或发布。run：`c426a3c8-57c9-4471-b130-0dd073b14081`。本轮累计 **4/4 次、0 重试、无剩余额度**。

最后许可 `last-short-policy.json` 绑定前三个锁的字节 SHA-256/run ID，仍使用同一 attempts 目录，仅将未用 cancel 槽改为 `last_one_short_output_180s`，没有重置任何锁。指令为“根据合成规则，只输出一个汉字：乙。不要解释、JSON、代码块或工具。”，上下文仍为原合成规则及必要任务元数据，没有学习数据、源码或个人聊天记录。未调整截断成功策略。

无密钥重启后，新候选与前三条终态、SSE 游标、handoff、幂等读取全部通过；额度用尽拒绝发生在 SDK 子进程创建及 provider fetch 之前。原锁与旧预算文件逐字节不变。学习库 25 张表原行指纹不变、完整性 ok；3080/8000 原 PID 与启动时间不变。隔离 8001 及本轮 SDK 子进程均已退出，8000 仍保持 mock。最终全量回归 **655 项通过**，临时 Windows 测试 fixture 已移除。

最后一次只证明真实任务创建、短输出候选落库和正常重启读取；**真实成功追问与运行取消仍未验收，不能宣称完整真实闭环通过**。本轮不会再调用模型或后台重试。证据：`output/harness-backend-20261015/real/last-short.json`、`last-short-policy.json`、`last-short-started.json`、`attempts/cancel.json`；传输诊断：`data/dsh-collaboration-controls/c426a3c8-57c9-4471-b130-0dd073b14081/transport.json`。离线成功：`output/harness-backend-20261015/last-short-offline-3b1913c8-e585-4984-a567-67ca52c8fe55/last-short.json`（0 真实请求，1 假传输）。全量回归：`output/harness-backend-20261015/last-short-backend-all-tests.xml`。独立备份：`output/backups/wenyan-before-harness-last-short-20261015.db`。旧的独立 2026-10-14 单次 grant 不计入此四次账本，也没有被重置。

以下为此前 180 秒方案的执行历史，不代表当前剩余额度。

上一轮（180 秒方案）：用户批准剩余 2 次单次等待上限延长至 180 秒，输出仍为 128 token、不自动重试、不重置原锁。实际新增 **1 次**请求，累计 **3/4 次**；约 3.6 秒收到模型流后达到输出上限，后端终态 `FAILED / DSH_OUTPUT_TOKEN_LIMIT`，候选成果为空。供应商回报 input_tokens=718、output_tokens=128，HTTP 200、完成标记已见、SSE 解析失败 0。这次不是 180 秒超时；不能把 token 上限结束当作成功成果。因没有完成候选可供追问，剩余 1 次未派发。原两条 UNKNOWN、旧预算与发送锁不变。

180 秒方案的零网络流程通过：真实 FastAPI/队列/SQLite/固定版 Harness，2 次假传输、真实请求 0 次。第二次复用为带 2 条历史的追问，在模型完成后、后端提交候选之前取消，验证结果丢弃、排队取消、幂等与重启读取。它**不等同于供应商推理中途取消，也没有已保存的成功追问成果**。最终全量回归 **644 项通过**。真实阶段只到新任务输出上限，追问和运行取消仍未真实验证。

本轮新许可将 `first` 与 `interrupted` 两个既有锁的逐字节 SHA-256 和 run ID 同时绑定，仍沿用同一 attempts 目录。未用 `followup` 槽承担新任务，未用 `cancel` 槽预留追问提交前取消；旧 60 秒许可不修改。180 秒同步限制请求、适配器与网络层，不扩大 token 或次数。

已用无密钥隔离后端正常重启读取三个终态、SSE、handoff 和原幂等键，新增请求 0 次，发送锁与预算文件不变。3080 PID 19768、8000 PID 51800 及启动时间未变，健康探测分别为预期 401/200；学习库 25 张表原行指纹不变、完整性 ok。隔离 8001 和本轮 SDK 子进程已退出，8000 仍为 mock。

本轮证据：`output/harness-backend-20261015/real/remaining-two-180.json`、`remaining-two-180-policy.json`、`readback-after-180.json`、`attempts/followup.json`；传输计数在 `data/dsh-collaboration-controls/71ea501f-d3cb-4328-a755-1bf941cf3417/transport.json`。离线成功报告：`output/harness-backend-20261015/remaining180-offline-066304df-b29b-499c-84d6-3af5fa0d35ca/remaining-two-180.json`。全量回归：`output/harness-backend-20261015/remaining180-backend-all-tests.xml`。独立备份：`output/backups/wenyan-before-harness-180s-20261015.db`。

以下记录为前两次 60 秒执行的历史，不代表当前剩余额度。

最新续接结果：用户已明确同意把首次超时作为真实异常恢复样本，并在原总上限 4 次不变下用剩余 3 次验证新任务、追问、运行取消。调整后的零网络全闭环及 118 项专项测试通过，最终后端全量 **636 项通过**。实际只执行了其中的新任务请求，仍在 60 秒内没有模型事件而超时；本轮累计 **2/4 次、0 重试、另 2 次未用**。已再次停止，没有执行真实追问或运行取消，也没有增加付费崩溃样本。原 run、原发送锁、原预算文件均未改变。

续接请求的证据：官方 HTTP 200、MIME 为 text/event-stream、响应头耗时 196 ms，11,996 ms 后收到首个流块，总计 4 块/56 字节。全流 SHA-256 与安全控制注释 `: keep-alive`（含 SSE 分隔换行）重复 4 次完全匹配；模型事件 0、SSE 解析失败 0、完成标记未出现，usage 未收到。[DeepSeek 官方保活说明](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)明确等待期间可持续发送这种注释。证据支持“在授权期限内上游仅返回保活、未返回模型事件”，不能据此确定具体排队/路由/账户原因，亦不能认定实际费用为零。

## 授权与实际用量

用户明确批准：最多 4 次请求，每次输出最多 128 token、等待最多 60 秒，只用合成内容，不自动重试；允许仅在本机借用 3080 的 DeepSeek 凭证引用。输入另限每次 8 KiB，输出预算合计最多 512 token，不含输入或供应商费用估算。

首次后端验收只尝试 1 次，用户另行确认后续接又尝试 1 次，当前累计 2 次真实 fetch、0 次重试，另 2 次未使用。两次都收到 HTTP 200，但没有可验收的完成事件或 usage，实际 token 与费用未知，不能当作零消耗。每个请求仍按原限制等待约 60 秒；首次验收器含启动与清理总耗时 68.787 秒。

超时 run：`1cb0a568-44b4-42fe-831f-cdc6c7ffe89a`。入队回执 `c50402be-5270-40f2-8c36-e5f35a9e0398` 只证明入队，不代表生成完成。prompt 2,175 字节，SHA-256 `331840de3d707fa65d8f9bbe2a7cde91aab7f5e35bf07bedabccddc51e2e34bd`。它只含冻结合成规则、任务指令、固定只读系统提示及必要协议元数据，没有学习记录、源码或聊天历史。

## 接入及防越权

`CollaborationController` 的真实模式现在使用 `BudgetedDshStdioAdapter`，必须显式配置 `WENYAN_COLLABORATION_BUDGET_POLICY_PATH`；没有预算文件不能启动真实后端。permit 固定 provider/model、4 个合成场景、来源内容、任务字段、历史结构和预算；scope、资料、历史或预算不匹配在创建 SDK 子进程前拒绝。

每场景在实际 fetch 前独占建立发送锁，重复场景、重启或崩溃都不清锁、不自动重发。模型侧无 shell、文件或 MCP 工具，供应商附加日志/插件上传关闭；非必要跟踪头移除。取消只作用于当前 run 的独占子进程。主机侧所有者探测让新建 SDK 子进程在所属测试后端异常退出后自行退出，不向别的服务发信号。

`cancel` 和 `interrupted` 场景在响应头后设置测试屏障，便于在供应商已收到请求但 Bridge 尚未验收成果时注入故障。该屏障不证明供应商停止推理或停止计费。模型完成、历史重建和审批权限仍保持既有严格规则。

## 实际验收范围

假传输验收使用真实本地 FastAPI、HTTP、队列、SQLite 和固定版 Harness，只把最外层 provider fetch 换成假 SSE；4 次假传输、真实网络 0 次。创建、候选读取、SSE 游标、正常重启后追问（同 task/manifest 的 2 条历史）、排队取消、收到响应头后的运行取消、异常退出后的 OUTCOME_UNKNOWN、不补发及预算拒绝全部通过。

真实首试通过了 HTTP 入队、SDK 握手和供应商 HTTP 200，随后触发 60 秒超时，没有候选成果。另以不带模型密钥的本地后端重新打开同一测试库：GET 状态、SSE 游标、handoff 和原幂等键重取均通过，仍为同一 OUTCOME_UNKNOWN run，发送锁逐字节未变，新增模型请求 0 次。这验证了真实超时记录的读取恢复，没有验证本轮的真实成功追问、运行取消或付费崩溃样本。

全量回归曾发现“取消发生在 initialize 写管道之前”被错误标为 RPC 写失败，已修复取消优先级并增加确定性回归。最终后端全量 **629 项通过**；临时 Windows workspace-ACL 测试 fixture 已移除。新增流字节/事件计数、响应 MIME 类别与耗时诊断，均不保存原文、reasoning 或原始异常；这些诊断是本次超时后补充，不能追溯判定本次供应商流停滞或客户端解析的根因。

上述 629 项是续接前结果。新续接模式将 continuation permit 绑定原 `first.json` 的逐字节 SHA-256 与原 run ID，仍写入原同一 `attempts` 目录；只改变一个未用槽的测试角色，不新开额度或重置锁。追问历史只允许来自全新任务的已完成合成候选，不把旧 OUTCOME_UNKNOWN 加入历史。新增续接回归后的最终全量为 636 项通过；临时 fixture 已移除。

## 证据位置

- 假传输全闭环：`output/harness-backend-20261015/offline-1a45e1ed-03ef-454e-b47b-0a86cd6b966a/acceptance.json`。
- 真实未完成现场：`output/harness-backend-20261015/real/acceptance.json`、同目录 `collaboration.db`、`attempts/first.json`。
- 零新调用的读取恢复：同目录 `readback.json`。
- 全量回归：`output/harness-backend-20261015/backend-all-tests.xml`。
- 独立学习库备份：`output/backups/wenyan-before-harness-backend-20261015.db`。
- 续接零网络全闭环：`output/harness-backend-20261015/continuation-offline-09dadb8f-8a24-4d3c-a5d4-c83a34cfb45f/continuation.json`；最初超时记录为明确标注的合成 fixture，实际 provider fetch 0 次。
- 实际续接现场：同一 `real` 目录下 `continuation.json`、`continuation-policy.json`、`continuation-started.json` 和 `attempts/interrupted.json`；槽名 interrupted 此次角色为 `new_task_after_unknown`，不是付费崩溃样本。
- 两条真实未知结果的无密钥重启读取：同目录 `readback-after-continuation.json`，新增模型请求 0 次，旧任务和新任务均保持 OUTCOME_UNKNOWN。
- 续接流证据：`data/dsh-collaboration-controls/d8d398dc-3bb1-4e73-98db-896020263a42/transport.json`。响应流摘要 `a14a07cc672be88058c459eb62a492d8c0753deb6ad0125669b269c0716844ad`，与 `: keep-alive\n\n` 重复 4 次的 UTF-8 SHA-256 相同；只保存计数/类别/散列，没有模型流原文。
- 续接最终全量：`output/harness-backend-20261015/continuation-backend-all-tests.xml`（636 项）；本轮独立备份：`output/backups/wenyan-before-harness-continuation-20261015.db`。

验收只使用隔离 8001，本轮相关后端和 SDK 子进程均已停止。3080 原 PID 19768、8000 原 PID 51800 及启动时间未变，8000 继续 mock；前端 5173 与后端健康均为 200，3080 无凭证探测为预期 401。学习库 25 张表行数及原行指纹不变，完整性 ok；已有协作库未被用作故障测试库。凭证未显示、未另存，没有读取个人会话日志或项目 `.env`。

## 当前停止点

当前累计 4/4 次、0 重试，预算耗尽。最后一次短合成输出成功并保存为 CANDIDATE，正常重启读取通过；真实追问与运行取消未验证。停止执行，不重发失败任务、不删除锁、不调整 max_tokens_as_success、不扩大数据范围或自动继续。下一步可在零模型调用下继续离线检查；任何新增真实请求必须另行确认最小预算与用途。现有完整真实闭环不得标记完成。
