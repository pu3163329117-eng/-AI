from . import models  # noqa: F401 - imports model metadata
from .migrations import apply_migrations
from .seed import seed_lessons
from .knowledge import seed_knowledge
from .session import Base, SessionLocal, engine


def init_db() -> None:
    """Initialize new databases, replay upgrades, then seed untouched development content."""
    Base.metadata.create_all(bind=engine)
    apply_migrations(engine)
    with SessionLocal() as db:
        seed_lessons(db)
        seed_knowledge(db)
        db.commit()
