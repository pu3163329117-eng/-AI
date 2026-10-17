# 最小合成包真实联调：单次验证成功

最新结果（报告落盘于 2026-10-14 23:59:12 +08:00）：用户已明确允许本机借用 3080 的 DeepSeek 凭证引用；独立 Harness 真实联调成功，官方接口 HTTP 200。只有 1 次 prompt 派发和 1 次真实 fetch 尝试，假传输 0 次、自动重试 0 次。耗时 3.057 秒，供应商返回 input 588 / output 26 token，低于 128 输出上限。

可见结果完全匹配：`{"candidate":"乙","source_id":"synthetic/harness-first-integration","review_status":"CANDIDATE"}`。状态 `WAITING_REVIEW`，不代表人工审核或发布。

报告为 `output/harness-real-synthetic-20261014/single-call/result.json`；发送锁为同级目录 `model-attempt.json`，保留防重复执行，不删除或重置。prompt 仍为原 1,904 字节及既定摘要，request body 摘要与先前假传输一致。回执 `89dffc51-0cf5-4df3-9971-020c9a36ace4` 与 turn 1、user event seq 5 对应，根 session running/idle 完整，shutdown 正常。

执行后核对：3080 PID 19768、8000 PID 51800 及启动时间不变；3080 无凭证探测 401、后端健康与前端 5173 均 200；学习库 25 张表行数和原行指纹不变，完整性 ok。密钥只在本机执行进程与独占子进程内存使用，未显示或另存，未读取个人会话日志或配置，未改写 3080。真实验证仅覆盖本次单轮 stdio 调用；运行中的 HTTP Bridge 继续 mock，没有扩大为真实追问、取消、恢复或更多付费调用，供应商账单也未核对。

以下保留先前预检与准备过程，旧的“未调用/待授权”描述不是当前最终状态。

用户最初明确授权只发送原合成包、最多调用 1 次、输出最多 128 token、等待最多 60 秒，不自动重试；保留 3080 服务及已有学习数据。此时尚未授权读取个人 Harness 凭证；后续又明确允许仅借用该 DeepSeek 凭证引用，不包括发送源码、学习记录、聊天历史、会话日志或插件清单，也不包括复用学习服务密钥。

## 本次实际结果

- 状态：`BLOCKED_CREDENTIAL / DSH_CREDENTIAL_NOT_CONFIGURED`，不是模型联调成功。
- 进程、用户、系统三个环境范围均未配置 `DEEPSEEK_API_KEY`；只检查是否存在，未显示密钥值，未读取项目 `.env` 或个人 Harness 配置。
- 未启动真实模型运行，模型请求 0 次，自动重试 0 次，未消费本次单次模型调用预算。
- 原预览包未改写，prompt 仍为 1,904 UTF-8 字节，SHA-256 为 `34bb804ac46d877888226ac0553a9232734c6fe9fb52c01a8d173735d2a129f4`。原文件的 `NOT_APPROVED_FOR_MODEL_SEND` 是生成时的历史状态，本轮用户消息及本文记录后续单次授权，不通过重生成来改写原包。

## 已完成的安全修正与复验

本机固定版本 Harness 的默认 DeepSeek 扩展会在模型输入之外附带 `dsh_session_log` 和 `dsh_plugin_packages`。独立受限 profile 现已额外禁用 `session-log-deepseek`、`plugin-package-inventory-deepseek`、`deepseek-llm-api-extensions`，与原先禁用的 shell、重试、原生日志共计 7 个禁用项。官方目标地址固定为 `https://api.deepseek.com/anthropic`，关闭 reasoning，为小输出预算保留可见文本空间。

一次性独立 home 的本机 `--dump-config` 复验通过；过程不传密钥、不调用模型，不接触运行中的 3080 服务。stdio 和 Bridge 专项共 72 项通过，包括新增的冻结包、内容扩展和预算扩展拒绝测试。

新增只读检查命令：

```powershell
python -m backend.scripts.harness_stdio_preview --verify-existing-packet --output-dir output/harness-real-synthetic-20261014
```

该命令没有模型调用路径，凭证就绪时也只报告 `PREFLIGHT_ONLY`，不自动发送。报告、配置转储和专项测试结果分别位于同目录的 `preflight.json`、`profile-dump.yml`、`offline-tests.xml`。配置转储不代表已完成网络请求、实际单次计数或操作系统强沙箱验收。

## 服务与数据保留

3080 仍为原 Node 进程 PID 19768；本地后端仍为 PID 51800，未重启。3080 无凭证探测返回 401，后端 `/api/health` 返回 200，前端 5173 返回 200。

使用只读 SQLite 连接对照 `output/backups/wenyan-before-stdio-offline-20261014.db`：25 张表的行数一致，原有行指纹全部保留，`integrity_check=ok`。本次未创建真实 run、未修改协作库或学习库。

## 继续所需条件

需要用户在独立协作启动环境本地配置 `DEEPSEEK_API_KEY`，不要将密钥发送到聊天。现有单次授权已经收到，不要求重复确认；但不会后台监视、自动启动或重试。凭证就绪后应在新的继续请求中执行一次受控联调，并记录实际请求次数和返回事件关联；任何可能已发送但结果不明的请求不得自动重派。

## 后续：3080 已配置，独立单次执行器就绪

用户提供的截图显示 3080 的 Models 页已配置 DeepSeek。固定版本实现说明该页把密钥存入本机凭证库，并不会设置独立进程环境；本轮再次检查 Process/User/Machine，`DEEPSEEK_API_KEY` 仍均不存在。尚未读取个人凭证文件或配置，也未发送真实请求。为避免要求用户再次复制密钥，已单独请求允许仅本机借用该 DeepSeek 引用，确认前不执行个人凭证读取。

新增 `backend/scripts/harness_synthetic_single_call.py` 和主机侧 `harness_single_call_guard.cjs`：

- 使用原 1,904 字节 prompt，新的独占 run/session 不改写合成包内容；只暴露固定只读系统提示。
- 拦截固定官方 Messages 地址，拒绝更换模型、内容、历史、工具、额外字段、reasoning 或 128-token 上限。
- 删除非必要用户/session 跟踪头，保留认证及必需协议头；不保存或打印密钥、reasoning、原始流或原始异常。
- 第一次真实 fetch 前独占创建 `model-attempt.json`，同进程第二次 fetch 和下一进程的重复执行均拒绝；异常、断线、超时后不删除该锁、不自动重试。计数表示本机 fetch 尝试，不等于供应商结算次数。
- 仅在显式启用个人凭证借用参数后读取指定文件中的 `refs.DEEPSEEK_API_KEY`，其余 `.env`、个人配置和会话日志不加载；该例外尚待用户确认，Bridge 本身的隔离政策不变。

实际运行固定版 Harness + 假 fetch/SSE 成功：initialize → prompt 回执 → 对应 user/turn → 可见 JSON → 根 idle → 正常 shutdown；候选为乙且保持 CANDIDATE，真实 fetch 0 次。最新报告为 `output/harness-real-synthetic-20261014/offline-e77d41bc-fd13-4728-bc5b-105426843d1a/result.json`，其中 input/output usage 为假传输数据，不能用于推理费用。

最终专项为 86 项通过，结果为同目录 `guard-tests.xml`。本轮还修复 Windows 终止子进程后管道 close 抛错覆盖取消结果及跳过所有权清理的问题，并增加回归测试。首次测试遇到 Python 3.14 的 mkdtemp ACL 问题后改用继承项目 ACL 的 UUID 目录；遗留的 11 个本轮空测试目录经逐项检查后已清理，不涉及既有数据。

最后复核：原 PID 19768（3080）和 51800（8000）及启动时间均未改变；3080 返回 401、8000 `/api/health` 返回 200；学习库 25 张表行数及原行指纹不变、完整性 ok。真实调用锁不存在，单次模型预算尚未使用。
