from backend.db import models  # noqa: F401 - imports model metadata

from backend.db.migrations import apply_migrations
from backend.db.seed import seed_lessons
from backend.db.session import Base, engine
from backend.db.session import SessionLocal


def init_db() -> None:
    """Initialize new databases, replay upgrades, then seed untouched development content."""
    Base.metadata.create_all(bind=engine)
    apply_migrations(engine)
    with SessionLocal() as db:
        seed_lessons(db)
