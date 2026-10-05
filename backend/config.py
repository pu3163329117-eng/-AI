from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# Vercel functions may write only under /tmp. This makes the shared deployment
# self-starting for demos; production should provide WENYAN_DATABASE_URL for a
# durable managed database.
_default_database = "sqlite:////tmp/wenyan.db" if os.getenv("VERCEL") else f"sqlite:///{ROOT / 'data' / 'wenyan.db'}"
DATABASE_URL = os.getenv("WENYAN_DATABASE_URL", _default_database)
API_PREFIX = "/api/v1"
