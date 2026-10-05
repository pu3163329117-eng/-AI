# Vercel 分享部署

仓库根目录的 `vercel.json` 将 React/Vite 前端部署到 `/`，并把 FastAPI 部署到同域的 `/server`。生产构建会自动使用 `/server` 作为 API 前缀，因此浏览器不会访问本机 `127.0.0.1`。

Vercel 上未配置 `WENYAN_DATABASE_URL` 时，Demo 使用函数临时目录中的 SQLite 数据库以便自动启动。该数据可能因冷启动或扩缩容而重置；若需要稳定保存学习档案，请在 Vercel 项目中设置 `WENYAN_DATABASE_URL` 指向托管 PostgreSQL 等持久化数据库后重新部署。
