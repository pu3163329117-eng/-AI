# 文言·推理 Demo

本地可运行的 Gold Case Demo：用《宋史·范仲淹传》中的“从”完成“作答 → 证据 → 暂放 → 提示 → 回溯 → 迁移”闭环。

## 启动

```powershell
python server.py
```

打开 `http://127.0.0.1:8000`。首次启动会创建 `data/wenyan-demo.db`。

## 架构

- `domain/`：无框架依赖的训练状态机与 Gold Case
- `storage/`：SQLite 事件、会话、幂等命令存储
- `server.py`：HTTP API 与静态资源服务
- `web/`：响应式黑白 UI

Demo 使用 SQLite 以零依赖在本机运行；生产基线仍应按工程规格迁移至 PostgreSQL、FastAPI、Redis 与对象存储。
