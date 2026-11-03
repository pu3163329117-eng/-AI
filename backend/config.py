from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# Retain the legacy fallback value; it is not an allowed production database.
# Access guards reject nonempty VERCEL and temporary SQLite in production.
# This beta requires persistent-server SQLite; PostgreSQL migration is not implemented.
_default_database = "sqlite:////tmp/wenyan.db" if os.getenv("VERCEL") else f"sqlite:///{ROOT / 'data' / 'wenyan.db'}"
DATABASE_URL = os.getenv("WENYAN_DATABASE_URL", _default_database)
API_PREFIX = "/api/v1"
# A rollout switch pauses new assessment creation without deleting saved trials.
ASSESSMENT_ENABLED = os.getenv("WENYAN_ASSESSMENT_ENABLED", "1").lower() not in {"0", "false", "off"}
