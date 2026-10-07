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
    assert versions == [1, 2, 3, 4]
    engine.dispose()
    database_path.unlink(missing_ok=True)


def test_legacy_ability_binding_migration_preserves_rows_without_inventing_confirmation():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE training_sessions (id VARCHAR(36) PRIMARY KEY, state_version INTEGER NOT NULL, snapshot JSON NOT NULL)"))
        connection.execute(text("CREATE TABLE lesson_abilities (lesson_id VARCHAR(36) PRIMARY KEY, ability_level VARCHAR(10), version INTEGER)"))
        connection.execute(text("INSERT INTO lesson_abilities VALUES ('legacy', 'L2', 3)"))
    apply_migrations(engine)
    apply_migrations(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT lesson_id, ability_level, version, content_version FROM lesson_abilities")).all() == [("legacy", "L2", 3, None)]
    engine.dispose()
