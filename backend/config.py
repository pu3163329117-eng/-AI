from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATABASE_URL = os.getenv("WENYAN_DATABASE_URL", f"sqlite:///{ROOT / 'data' / 'wenyan.db'}")
API_PREFIX = "/api/v1"
