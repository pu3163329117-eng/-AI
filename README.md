# 文言·推理

真实全栈 Demo，通过证据、判断、回溯和迁移进行文言实词训练。

## 本地启动

React / Vite / TypeScript 前端使用 5173；FastAPI / SQLAlchemy 后端使用 8000。SQLite 是本地开发数据库，运行数据不会提交到 Git。

在两个 PowerShell 终端分别启动：

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

```powershell
Set-Location frontend
npm ci
npm run dev
```

打开 [本地预览](http://127.0.0.1:5173/)。Vite 通过 `/api` 代理访问后端；局域网同事使用本机实际内网 IP 的 5173 端口。后端保持回环监听。

## 验证

```powershell
python -m pytest backend/tests -q -p no:cacheprovider
Set-Location frontend
npm run build
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health
```

## 执行计划与当前迭代

见 [合并开发计划](docs/development-plan.md)。已有原文五层语境、精确词组点读、暂放回看、服务端定位保存和刷新恢复；扩大语境不自动代答或加分。本轮补齐 13 个来源单元的原文范围与版本，修正三处种子材料，并加入“草稿 → 署名审核 → 发布”版本门槛。修改已发布内容后需重新审核，已开始的学习记录仍使用冻结版本。

原文明确区分全文 / 章节 / 节选范围，逐项来源见 [资料清单](docs/material-sources.md)。核对公开原文不代表真人教师审核；旧演示课程标为未审核，新发布需审核当前版本。署名尚未关联认证账号。当前是规则式全栈 Demo，不等同于完整 AI 智能体。ReasoningGraph、模型 Provider、生产鉴权和持久云数据库为后续任务。本地无鉴权内容管理接口不得直接暴露公网。

字词知识库按每次出现的位置保存本句义、词性、变量／本句相对确定的判断依据，点击词组内部字也能查看词项解释。其他语境来自已收录原文真实位置，支持分页；历史版本不会误用新版偏移。新增注释全部为草稿，不代表教师认证。各篇覆盖进度可在原文阅读器展开查看，架构与只读完整性审计见 [字词知识库](docs/knowledge-base.md)。

目前 13 个原文单元已有 3,495 条注释草稿，覆盖 4,362 / 4,362 正文字位。97 项后端回归及前端生产构建通过，实际桌面／手机验收与内容边界见 [知识库验收记录](docs/knowledge-acceptance.md)。
