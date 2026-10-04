# 文言·推理

可本地运行的全栈 Demo：以“证据—判断—回溯—迁移”完成一条文言实词推理训练闭环。

## 技术栈

- `frontend/`：React、Vite、TypeScript，开发预览运行在 `http://127.0.0.1:5173`
- `backend/`：FastAPI、SQLAlchemy、SQLite，API 运行在 `http://127.0.0.1:8000`

SQLite 是当前 Demo 的零配置开发数据库；启动服务时会自动创建 `data/wenyan.db`，该运行数据不会提交到 Git。

## 本地启动

在两个 PowerShell 终端分别执行：

```powershell
# 终端 1：安装后端依赖并启动 API
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

```powershell
# 终端 2：安装前端依赖并启动开发预览
Set-Location frontend
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 已将 `/api` 请求代理到 FastAPI 的 8000 端口。

## 验证

```powershell
# API 单元测试
python -m pytest backend/tests/test_api.py -q

# 前端生产构建
Set-Location frontend
npm run build

# 健康检查
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health
```