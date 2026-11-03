# 配置变量与无真实值示例

本说明依据本候选的公开配置代码，未读取旧环境文件、密钥、账号或生产配置。域名、路径和构建标签均为合成示例；所有私密字段留空。示例不是可直接上线的配置，不包含邀请码、OTP、账号清单或数据库数据。

## 配置来源与加载

服务通过操作系统、服务管理器或平台私密配置注入进程环境。应用、认证、邮件和支持权限没有覆盖所有变量的通用 `.env` 自动加载器。AI loader 仅识别后端环境文件中的 `WENYAN_AI_ENABLED`、`WENYAN_AI_DATA_POLICY`、`WENYAN_AI_MODEL`、`DEEPSEEK_API_KEY`，同名进程变量优先；它不执行文件内容。不要将私有环境文件提交到仓库。

数据库引擎在导入时创建，修改 URL 不会自动重连或迁移数据。支持负责人配置则在权限检查中读取。前端 `VITE_*` 是公开的构建输入，不能承载认证或服务商秘密。

## 应用、存储与访问

| 变量 | 默认/可选值 | 用途与约束 |
| --- | --- | --- |
| `WENYAN_ENV` | `development`；`test`、`production` | 非空 `VERCEL` 也会触发生产识别。 |
| `WENYAN_ACCESS_MODE` | `local`；`invite` | local 是本机开发方式；生产要求 invite，且 AI 与协作桥关闭。 |
| `WENYAN_DATABASE_URL` | 未设时为本地 `data/wenyan.db`；有 `VERCEL` 时保留历史 `/tmp` fallback | 生产必须显式指定绝对 SQLite 文件 URL，父目录须已存在并通过门禁；内存/临时库不允许，PostgreSQL 迁移未实现。见[部署边界](../DEPLOYMENT.md)。 |
| `VERCEL` | 平台提供 | 任意非空值，包括 `0`，都被视为平台标志；当前后端拒绝该运行方式。不能手动清除标志来规避存储要求。 |
| `WENYAN_ASSESSMENT_ENABLED` | `1` | `0`/`false`/`off` 暂停新试测创建，保留已存试测；不表示开放正式定级。 |
| `WENYAN_ADMIN_ENABLED` | local 默认开启；invite 默认关闭 | 教研管理总开关；生产内测预检要求显式关闭。开启不替代有效 admin 身份及服务端门禁。 |
| `WENYAN_AUTH_ORIGINS` | 空；invite 必填 | 逗号分隔精确 `scheme://host[:port]`，不含路径、通配符或用户信息；生产须 HTTPS。 |
| `WENYAN_AUTH_COOKIE_SECURE` | `true` | 生产必须为 true。仅非生产、显式回环 origin 可设 false。 |
| `WENYAN_AUTH_LOGIN_METHOD` | `password`；`email_code` | 邀请制邮箱内测使用 email_code，部署预检要求该值。默认 password 不是已验证的生产方案。 |

认证/支持布尔开关接受 `true/false`、`1/0`、`on/off`，大小写不敏感；无效拼写会拒绝配置。

## 邮箱验证码与支持负责人

| 变量 | 默认/要求 | 用途与约束 |
| --- | --- | --- |
| `WENYAN_AUTH_EMAIL_PROVIDER` | `resend`；合成测试可用 `mock` | 生产禁止 mock；mock 仅允许合成/回环调用，不发送邮件、不返回验证码。 |
| `WENYAN_AUTH_OTP_SECRET` | 空；邮箱登录需至少 32 个 UTF-8 字节 | 私有 OTP HMAC 秘密。生产拒绝明显占位或低多样性示例；需私下安全生成和保管，不放前端或 Git。 |
| `WENYAN_AUTH_EMAIL_FROM` | 空 | Resend 的经验证发件地址。生产拒绝示例域名/占位地址；DNS 与实际送达须另验。 |
| `RESEND_API_KEY` | 空 | 仅后端使用；生产要求有效格式且非占位。源码校验不是服务商凭据有效性验证。 |
| `WENYAN_AUTH_EMAIL_DAILY_LIMIT` | `80`，范围 1–10000 | 应用发送预算；生产预检要求显式值，不代表服务商额度或容量已验。 |
| `WENYAN_SUPPORT_ADMIN_ENABLED` | `false` | 支持收件箱独立开关，不自动开启教研后台。 |
| `WENYAN_SUPPORT_OWNER_EMAIL` | 空 | 仅一个负责人邮箱；规范化后与实际用户邮箱精确匹配，还须 invite、有效 admin、未禁用及支持开关。不是提权命令。 |

支持开启而负责人配置缺失/无效时，支持请求按配置错误拒绝，普通会话报告无支持能力并保持可用；支持关闭时无须填写负责人。公开联系渠道与负责人特权资格不同，不要发布私有身份关联。

## 留空的生产配置骨架

这份说明性键值清单不会被仓库自动加载。示例路径不存在也不能通过生产检查；需负责人选择真实持久卷并私下注入必需值。留空的 OTP/邮件字段会令邮箱登录配置检查失败，不能直接部署。当前后端目标不能是 Vercel；删除平台标志不会让临时磁盘变持久。

```dotenv
WENYAN_ENV=production
WENYAN_ACCESS_MODE=invite
WENYAN_DATABASE_URL=sqlite:////srv/wenyan-example/state/example-only.sqlite
WENYAN_AUTH_ORIGINS=https://app.example.invalid
WENYAN_AUTH_COOKIE_SECURE=true
WENYAN_AUTH_LOGIN_METHOD=email_code
WENYAN_AUTH_EMAIL_PROVIDER=resend
WENYAN_AUTH_OTP_SECRET=
WENYAN_AUTH_EMAIL_FROM=
RESEND_API_KEY=
WENYAN_AUTH_EMAIL_DAILY_LIMIT=80
WENYAN_ADMIN_ENABLED=false
WENYAN_SUPPORT_ADMIN_ENABLED=false
WENYAN_SUPPORT_OWNER_EMAIL=
WENYAN_AI_ENABLED=0
WENYAN_COLLABORATION_ENABLED=0
WENYAN_COLLABORATION_REAL_CALLS_ENABLED=0
```

下例仅说明合成测试隔离模式。内存库不持久，也不保证跨连接的完整应用预览。仓库测试由夹具创建新库并模拟邮件/模型，请使用 README 的测试命令。

```dotenv
WENYAN_ENV=test
WENYAN_ACCESS_MODE=local
WENYAN_DATABASE_URL=sqlite:///:memory:
WENYAN_ADMIN_ENABLED=false
WENYAN_SUPPORT_ADMIN_ENABLED=false
WENYAN_AI_ENABLED=0
WENYAN_COLLABORATION_ENABLED=0
WENYAN_COLLABORATION_REAL_CALLS_ENABLED=0
```

## 前端构建变量

| 变量 | 含义 |
| --- | --- |
| `VITE_API_ROOT` | API 基址前缀。空值表示同源；改变托管/代理需另验路由、origin 和 cookie。 |
| `VITE_BETA_SUPPORT_EMAIL` | 可公开联系渠道，不是后台授权配置。 |
| `VITE_BUILD_VERSION` | 公开构建标记，例如 `synthetic-build-example`。 |

`npm run build:release` 的专用 `vite.production.config.mjs` 设置 `envDir:false`，显式固定上述三个 define；shell 中的 `VITE_*` 不会覆盖固定值。修改正式构建输入是另一个需审查的变更。本例不修改构建配置，也不声称 API 前缀会自动变为 `/server`。

## 默认关闭的 AI 与协作桥

邀请制内测须保持 AI 和协作桥关闭；下表用于理解代码，不授权模型调用。`WENYAN_AI_ENABLED` 默认 `0`；`WENYAN_AI_DATA_POLICY` 只接受 `synthetic_only`（默认）或 `minimal_learning`；`WENYAN_AI_MODEL` 只接受 `deepseek-flash`（默认）或 `deepseek-v4-pro`；`DEEPSEEK_API_KEY` 默认为空且必须保密。有 key 不等于允许发送。

协作桥变量由 `backend/collaboration/config.py` 读取。关闭时不依赖开发机 Harness 路径；开启需另行审查/授权。

| 变量 | 默认或含义 |
| --- | --- |
| `WENYAN_COLLABORATION_ENABLED`、`WENYAN_COLLABORATION_REAL_CALLS_ENABLED` | 默认 `0`；开关不替代调用预算或批准。 |
| `WENYAN_COLLABORATION_TOKEN` | 空；开启时 24–512 个字符，作为私密值保管。 |
| `WENYAN_COLLABORATION_DATABASE_URL` | 独立本地 `data/collaboration.db`，仅接受 SQLite URL。 |
| `WENYAN_COLLABORATION_RUNTIME` | `mock`；或经审查的 `dsh-stdio`。 |
| `WENYAN_COLLABORATION_ALLOWED_ORIGINS` | 默认本机 5173 的两个精确 origin，不是公开部署配置。 |
| `WENYAN_COLLABORATION_BUDGET_POLICY_PATH` | 预算策略的绝对路径；真实适配器另有冻结及路径约束。 |
| `WENYAN_COLLABORATION_DSH_BIN` | Harness 可执行文件绝对路径；代码中开发机默认不适用于新机器。 |
| `WENYAN_COLLABORATION_DSH_HOME`、`WENYAN_COLLABORATION_WORKSPACE` | 两个不同的专用绝对目录，不能是用户 home。 |
| `WENYAN_COLLABORATION_PROFILE` | 默认 `wenyan-collaboration-readonly`，须符合名称规则。 |
| `WENYAN_COLLABORATION_PROVIDER`、`WENYAN_COLLABORATION_MODEL` | 默认 `deepseek-official`、`deepseek-flash`。 |
| `WENYAN_COLLABORATION_MAX_TOKENS` | 默认 4096，范围 1–65536；预算适配器可能收紧。 |
| `WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS` | 默认 300，范围 1–3600。 |
| `WENYAN_COLLABORATION_MOCK_STEP_DELAY_SECONDS` | 默认 0.01，范围 0–30 秒。 |
| `WENYAN_COLLABORATION_MAX_PROMPT_BYTES`、`WENYAN_COLLABORATION_MAX_OUTPUT_BYTES` | 默认 262144、131072；各自范围 1024–1048576。 |
| `WENYAN_SINGLE_CALL_CONFIG` | 单次受预算联调工具的专用配置位置；非应用启动必填，也不等于发送授权。 |

## 可选运维工具变量

这些不是应用启动必填项。不要运行工具以测试真实邮件、备份或私有配置；目标、凭据与操作需按对应流程批准。

`backend/scripts/beta_ops_health.py`：`WENYAN_OPS_STATE` 为健康状态文件；`WENYAN_OPS_OFFSITE_RECEIPT`（回退 `WENYAN_OFFSITE_RECEIPT_PATH`）为异地备份回执，工具强制固定私有路径，不允许任意改路径。门槛为 `WENYAN_OPS_BACKUP_MAX_HOURS=30`（1–168）、`WENYAN_OPS_DISK_MIN_MIB=2048`（128–1048576）、`WENYAN_OPS_OTP_WARNING_REMAINING=20`（1–10000）、`WENYAN_OPS_ALERT_DAILY_LIMIT=4`（1–10）、`WENYAN_OPS_ALERT_COOLDOWN_SECONDS=3600`（60–86400）、`WENYAN_OPS_ALERT_REMINDER_SECONDS=21600`（3600–604800）。`WENYAN_OPS_ALERT_TO` 为私有接收地址；`WENYAN_OPS_ALERT_FROM` 回退认证发件地址，`WENYAN_OPS_RESEND_API_KEY` 回退 `RESEND_API_KEY`，不得把真实值填到本说明。

`backend/scripts/beta_offsite_backup.py`：`WENYAN_OFFSITE_CONFIG` 可指向受保护私有 JSON，同名进程变量优先。它读取 `WENYAN_OFFSITE_REGION`、`WENYAN_OFFSITE_BUCKET`、`WENYAN_OFFSITE_PREFIX`、`WENYAN_OFFSITE_RECIPIENT`（age 公钥接收方）、`WENYAN_OFFSITE_SECRET_ID`、`WENYAN_OFFSITE_SECRET_KEY`、`WENYAN_OFFSITE_TOKEN`、`WENYAN_OFFSITE_AGE_BIN`、`WENYAN_OFFSITE_IDENTITY_PATH`（解密身份文件）、`WENYAN_OFFSITE_MAX_BYTES`（默认 268435456，范围 16384–1073741824）、`WENYAN_OFFSITE_RECEIPT_PATH`。密钥、身份文件、存储桶/对象位置和回执均保持私有；age/COS 工具及真实恢复能力需另验。

`TMP`、`TEMP`、`TMPDIR` 是系统临时目录变量，也参与生产 SQLite 临时根判定；改写它们不解除 Linux `/tmp`、`/var/tmp` 禁止。`WENYAN_TEST_SITE_DIR` 仅为测试子进程依赖路径，不是生产配置；`WENYAN_COLLABORATION_TASK_V1` 是内部任务包标记，不是启用开关。

## 公开源码依据

- [应用默认值](../backend/config.py)、[认证设置](../backend/auth/settings.py)、[邮箱服务](../backend/auth/email_service.py)。
- [支持负责人权限](../backend/support_admin_access.py)、[请求存储门禁](../backend/access.py)、[发布预检](../backend/scripts/beta_preflight.py)、[数据库引擎](../backend/db/session.py)。
- [AI 设置](../backend/ai/settings.py)、[协作桥设置](../backend/collaboration/config.py)、[正式构建设置](../frontend/vite.production.config.mjs)。

以上是仓库代码链接；未读取或复制旧 `.env.example`、私有环境文件或平台秘密值。本页不会创建账号、提权、发送邮件、改变配置或部署。
