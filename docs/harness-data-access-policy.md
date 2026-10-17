# DeepSeek Harness 协作数据访问政策

2026-10-15 最新授权结算：原四次后端合成预算已用满（4/4、无重试）。用户先批准余下调用延长至 180 秒，随后批准最后一次仅改用短合成指令；每次仍最多 128 输出 token，最后返回“乙”（供应商 usage 694 输入/1 输出）。仅主机执行器在内存借用原凭证，controller 未访问个人凭证库，密钥未显示或另存。原三个发送锁与旧预算逐字节不变，同一账本四槽均已保留。授权已耗尽，不延伸为后续调用或持续访问许可；学习库 25 表原行不变，3080 保留。详见 [结算与证据](harness-backend-integration-20261015.md)；下文较早用量是历史记录。

日期：2026-10-14。适用范围：项目协作 Bridge 第一阶段。

## 允许范围

首版只允许调用方显式提交的 `synthetic` 与 `project_non_sensitive` 上下文片段。每段必须带来源 ID、来源版本、四层上下文分类和内容摘要。Bridge 仅把冻结 manifest 与任务指令组合为 `WENYAN_COLLABORATION_TASK_V1` 输入；不扫描仓库，不根据来源 ID 打开文件，不连接学习库，也不复制当前聊天的完整历史。

协作数据保存在独立的 `data/collaboration.db`，表仅包括 tasks、context_manifests、messages、runs、artifacts 与 audit_events。它启用 SQLite 外键、WAL 和 `busy_timeout`，由单 worker 负责关键写入。启动时会拒绝把协作库配置成与 `WENYAN_DATABASE_URL` 相同的文件。

## 禁止范围

- 不读取或写入 `data/wenyan.db`，不共享真实学生档案、学习会话、测评、积分或个人理由。
- 不读取项目 `.env`、用户主目录、个人 Harness home、个人会话日志、Git 凭证或其它项目。
- 不提供 Shell、任意文件工具、任意 SQL、发布、部署、教师审核、积分或正式评分工具。
- 不把模型摘要当作事实、长期决定或新的权限；所有输出以 `CANDIDATE` 暂存。
- 不因本机进程运行就宣称模型推理离线；真实模式会把 manifest 中的明确内容发给所选模型服务。

## 运行时隔离

仓库提供 `backend/collaboration/harness_profile`，锁定本机 `@deepseek-ai/dsh` 0.2.0-rc.2 组成。除禁用 persistent-bash/persistent-pwsh 外，llm-retry 和原生 JSONL 持久化 sessions 也关闭，避免隐式付费重试和 reasoning/raw stream 落盘。每个 stdio run 在项目 data 下新建独占 DSH_HOME/workspace，拒绝链接、junction、路径穿越和非空 workspace；不复用旧目录。home 级 patch 被拒绝，既有 3080 服务不被复用或终止。

这一级隔离只证明 profile 没有暴露 Shell/MCP 工具，并不等于操作系统级强沙箱已经验收。第一阶段因此只发送内联的受控文字，不挂载真实源码目录或数据库路径。

## 身份、密钥和日志

HTTP 身份由回环地址、服务令牌和 Origin 白名单共同约束。3080 页面登录状态不授予 Bridge 权限。服务令牌和 `DEEPSEEK_API_KEY` 只从进程环境读取，不写入源码、协作库或文档；Bridge 不加载项目 `.env` 作为协作配置。

2026-10-14 单次合成验证例外：用户另外明确允许主机侧单次执行器仅借用 3080 凭证库中的 `refs.DEEPSEEK_API_KEY`，在本机内存注入独立子进程。不显示或另存密钥，不加载个人配置、会话日志或任何 `.env`，不改写既有服务。该次授权已经用完，Bridge 仍只从环境读取凭证；不得推导为长期访问个人 home、自动执行或更多模型调用的许可。主机发送保护保留一次性锁、固定原合成包/官方目标/128 输出 token/60 秒/无重试。

2026-10-15 后端合成闭环例外：用户另行批准最多 4 次、每次 128 输出 token/60 秒，并允许同样的本机凭证借用；controller 仍不读取个人 home，主机验收器只把已明确借用的单项凭证注入自建后端进程。真实模式必须带冻结的 `budget_policy_path`，场景发送锁持久保存，重启不清零。目前实际只尝试 1 次后超时为 OUTCOME_UNKNOWN，无重试，其他调用已暂停，详见 `harness-backend-integration-20261015.md`。追加的字节/事件/时延诊断只有计数、类别及散列，不保存原始流或模型 reasoning。

审计记录事件类型、actor、task/run 标识、manifest 版本/摘要、状态、限制和诊断码；历史重建另记 message ID、摘要和策略。候选只保存顶层可见 text，reasoning/raw stream 不保存。stderr 只保留散列与计数，不回显原文。stdio 追问只重建同任务、同 manifest 的已完成历史，模型文本保持未验证候选；原生 session restore 未验证，不自动重放旧范围或不明确结果。当前未实现自动保留期清理，属于后续运维项。

## 后续扩展门槛

2026-10-15 续接授权与实际停止点：用户批准保留已超时任务作为异常恢复样本，只使用原四槽账本剩余槽，不新开额度；continuation permit 绑定原锁摘要及 run ID。实际只再执行一个新任务后因上游仅返回保活再次超时，累计 2/4 次、其余 2 次暂停；无重试、无真实追问/取消或额外崩溃调用。原未知任务和锁不变；controller 和读取恢复过程均不读取个人凭证，只有这次明确批准的主机执行器做一次内存借用。

真实学生投影、知识库查询、候选写回、MCP 工具、源码读取或隔离修改均不在本阶段权限内。每类能力都需要单独的数据字段投影、身份校验、拒绝测试和用户授权；不得借用学生理由反馈 Provider 的既有许可。
