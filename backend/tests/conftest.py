"""Bind legacy integration tests before collection, never to the running DB.

Individual modules setting an environment variable after another module has
imported backend.main cannot change its already-created engine. Initialize a
shared in-memory engine here, before any test modules or application imports.
Tests with their own isolated dependency overrides remain unchanged.
"""
import os

os.environ['WENYAN_DATABASE_URL'] = 'sqlite:///:memory:'

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402
import backend.db.session as database  # noqa: E402

database.engine.dispose()
database.engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False}, poolclass=StaticPool)
database.SessionLocal = sessionmaker(bind=database.engine, autocommit=False, autoflush=False, expire_on_commit=False)
