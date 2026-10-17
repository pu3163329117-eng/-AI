from __future__ import annotations

from pathlib import Path

try:
    from backend.config import DATABASE_URL as LEARNER_DATABASE_URL
except ModuleNotFoundError:
    from config import DATABASE_URL as LEARNER_DATABASE_URL

from .config import CollaborationSettings, load_settings
from .database import create_collaboration_database, init_collaboration_database
from .runtime import MockHarnessAdapter
from .budget_runtime import BudgetedDshStdioAdapter
from .service import CollaborationService, CollaborationWorker


def _sqlite_path(url: str) -> Path | None:
    if not url.startswith("sqlite:///") or url.endswith(":memory:"):
        return None
    return Path(url.removeprefix("sqlite:///")).resolve()


class CollaborationController:
    def __init__(self):
        self.settings: CollaborationSettings | None = None
        self.service: CollaborationService | None = None
        self.worker: CollaborationWorker | None = None
        self.engine = None

    def startup(self) -> None:
        settings = load_settings()
        self.settings = settings
        if not settings.enabled:
            return
        collaboration_path = _sqlite_path(settings.database_url)
        learner_path = _sqlite_path(LEARNER_DATABASE_URL)
        if collaboration_path is not None and learner_path is not None and collaboration_path == learner_path:
            raise ValueError("COLLABORATION_DATABASE_MUST_BE_SEPARATE")
        adapter = MockHarnessAdapter(step_delay=settings.mock_step_delay_seconds) if settings.runtime == "mock" else BudgetedDshStdioAdapter(settings)
        engine, factory = create_collaboration_database(settings.database_url)
        init_collaboration_database(engine)
        service = CollaborationService(factory, adapter)
        service.recover_interrupted()
        worker = CollaborationWorker(service)
        worker.start()
        self.engine = engine
        self.service = service
        self.worker = worker

    def shutdown(self) -> None:
        if self.worker:
            self.worker.stop()
        if self.engine:
            self.engine.dispose()
        self.worker = None
        self.service = None
        self.engine = None


controller = CollaborationController()
