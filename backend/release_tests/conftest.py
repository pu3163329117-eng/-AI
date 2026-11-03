"""Synthetic-only configuration for the isolated release test slice."""
import os
import tempfile
from pathlib import Path

for _key in tuple(os.environ):
    if _key.startswith("WENYAN_"):
        os.environ.pop(_key, None)
_workspace = tempfile.TemporaryDirectory(prefix="wenyan-release-synthetic-")
os.environ["WENYAN_ENV"] = "test"
os.environ["WENYAN_ACCESS_MODE"] = "local"
os.environ["WENYAN_AI_ENABLED"] = "0"
os.environ["WENYAN_COLLABORATION_ENABLED"] = "0"
os.environ["WENYAN_COLLABORATION_REAL_CALLS_ENABLED"] = "0"
os.environ["WENYAN_DATABASE_URL"] = "sqlite:///" + (Path(_workspace.name) / "synthetic.db").as_posix()
os.environ.pop("VERCEL", None)
# No TestClient monkeypatch: each compatible test explicitly supplies its header.
# test_sync_persistence explicitly removes it for the missing-contract counterexample.
