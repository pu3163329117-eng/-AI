from backend.db import models  # noqa: F401 - imports model metadata
from backend.db.session import Base, engine


def init_db() -> None:
    """Idempotent development-schema initializer; replace with Alembic migrations for production."""
    Base.metadata.create_all(bind=engine)
