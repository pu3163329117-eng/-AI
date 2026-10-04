from backend.db import models  # noqa: F401 - imports model metadata
from sqlalchemy import inspect

from backend.db.session import Base, engine


def init_db() -> None:
    """Idempotent development-schema initializer; replace with Alembic migrations for production."""
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name != "sqlite":
        return

    # The local demo can be upgraded in place before a formal Alembic migration layer is introduced.
    columns = {column["name"] for column in inspect(engine).get_columns("training_sessions")}
    if "profile_id" not in columns:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE training_sessions ADD COLUMN profile_id VARCHAR(36)")
            connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_training_sessions_profile_id ON training_sessions (profile_id)")
