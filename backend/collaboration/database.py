from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .models import CollaborationBase


def create_collaboration_database(database_url: str) -> tuple[Engine, Callable[[], Session]]:
    if not database_url.startswith("sqlite:///"):
        raise ValueError("COLLABORATION_DATABASE_MUST_BE_SQLITE")
    db_path = database_url.removeprefix("sqlite:///")
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool if db_path == ":memory:" else None,
    )

    @event.listens_for(engine, "connect")
    def set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        if db_path != ":memory:":
            cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    factory = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)
    return engine, factory


def init_collaboration_database(engine: Engine) -> None:
    CollaborationBase.metadata.create_all(bind=engine)
