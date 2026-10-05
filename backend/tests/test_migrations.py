from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from backend.db.migrations import apply_migrations


def test_migration_registry_is_replay_safe_for_a_legacy_sqlite_database():
    database_path = Path(__file__).parent / "migration-test.db"
    database_path.unlink(missing_ok=True)
    engine = create_engine(f"sqlite:///{database_path}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE training_sessions (id VARCHAR(36) PRIMARY KEY, state_version INTEGER NOT NULL, snapshot JSON NOT NULL)"))

    apply_migrations(engine)
    apply_migrations(engine)

    columns = {item["name"] for item in inspect(engine).get_columns("training_sessions")}
    assert {"profile_id", "lesson_id"}.issubset(columns)
    with engine.connect() as connection:
        versions = [row[0] for row in connection.execute(text("SELECT version FROM schema_migrations ORDER BY version"))]
    assert versions == [1, 2]
    engine.dispose()
    database_path.unlink(missing_ok=True)
