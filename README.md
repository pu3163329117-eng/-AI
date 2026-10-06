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

见 [合并开发计划](docs/development-plan.md)。本轮接入原文五层语境、精确词组点读、暂放回看、服务端定位保存和刷新恢复；扩大语境不自动代答或加分。

原文明确区分全文 / 章节 / 节选范围，内容仍须逐篇教研校勘。当前是规则式全栈 Demo，不等同于完整 AI 智能体。模型 Provider、生产鉴权、持久云数据库及 Source / Review / Version 内容审核为后续任务。本地无鉴权内容管理接口不得直接暴露公网。
