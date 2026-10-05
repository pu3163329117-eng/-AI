"""Small, replay-safe SQLite schema migration registry for the local development baseline."""
from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import Engine, inspect, text


Migration = tuple[int, str, Callable[[Engine], None]]


def _ensure_column(engine: Engine, table: str, column: str, definition: str) -> None:
    if column not in {item["name"] for item in inspect(engine).get_columns(table)}:
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))


def _v1_profile_session(engine: Engine) -> None:
    _ensure_column(engine, "training_sessions", "profile_id", "VARCHAR(36)")
    with engine.begin() as connection:
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_training_sessions_profile_id ON training_sessions (profile_id)"))


def _v2_lesson_session(engine: Engine) -> None:
    _ensure_column(engine, "training_sessions", "lesson_id", "VARCHAR(36)")
    with engine.begin() as connection:
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_training_sessions_lesson_id ON training_sessions (lesson_id)"))


MIGRATIONS: tuple[Migration, ...] = (
    (1, "profile-session-link", _v1_profile_session),
    (2, "lesson-session-link", _v2_lesson_session),
)


def apply_migrations(engine: Engine) -> None:
    """Run every missing migration exactly once. Safe to call on every service boot."""
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR(120) NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL)"))
        applied = {row[0] for row in connection.execute(text("SELECT version FROM schema_migrations"))}
    for version, name, upgrade in MIGRATIONS:
        if version in applied:
            continue
        upgrade(engine)
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO schema_migrations (version, name) VALUES (:version, :name)"), {"version": version, "name": name})
