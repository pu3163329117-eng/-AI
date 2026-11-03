"""Synthetic checks for serverless storage boundaries; no real database is opened."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.access as access
import backend.scripts.beta_preflight as preflight
from backend.auth.settings import load_access_settings
from backend.db.session import get_db
from backend.main import app


@pytest.mark.parametrize('marker', ['1', 'true', 'synthetic-nonempty-marker'])
def test_nonempty_vercel_marker_cannot_select_local_development(monkeypatch, marker):
    monkeypatch.setenv('VERCEL', marker)
    monkeypatch.setenv('WENYAN_ENV', 'test')
    monkeypatch.setenv('WENYAN_ACCESS_MODE', 'local')
    monkeypatch.setenv('WENYAN_AI_ENABLED', '0')
    monkeypatch.setenv('WENYAN_COLLABORATION_ENABLED', '0')
    monkeypatch.setenv('WENYAN_COLLABORATION_REAL_CALLS_ENABLED', '0')
    monkeypatch.delenv('WENYAN_AUTH_ORIGINS', raising=False)
    with pytest.raises(ValueError, match='Production requires'):
        load_access_settings()


def test_http_without_lifespan_rejects_ephemeral_production_storage(monkeypatch):
    # TestClient without a context manager intentionally does not invoke lifespan.
    # No request should serve a production configuration that has not passed
    # the persistent-storage guard.
    settings = SimpleNamespace(production=True, mode='invite', admin_enabled=False, allowed_origins=('https://testserver',))
    monkeypatch.setattr(access, 'load_access_settings', lambda: settings)
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setenv('WENYAN_DATABASE_URL', 'sqlite:///:memory:')
    response = TestClient(app).get('/api/health')
    assert response.status_code == 503
    assert response.json() == {'error': {'code': 'ACCESS_CONFIGURATION_INVALID'}}
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('invalid', ['missing', 'memory', 'temporary', 'vercel'])
def test_invalid_storage_denied_before_db_dependency_and_without_details(monkeypatch, tmp_path, invalid):
    settings = SimpleNamespace(production=True, mode='invite', admin_enabled=False, allowed_origins=('https://testserver',))
    monkeypatch.setattr(access, 'load_access_settings', lambda: settings)
    temporary = tmp_path / 'synthetic-temp'
    temporary.mkdir()
    monkeypatch.setattr(preflight, '_temporary_roots', lambda: [temporary.resolve()])
    monkeypatch.delenv('VERCEL', raising=False)
    if invalid == 'missing':
        monkeypatch.delenv('WENYAN_DATABASE_URL', raising=False)
    elif invalid == 'memory':
        monkeypatch.setenv('WENYAN_DATABASE_URL', 'sqlite:///:memory:')
    else:
        path = (temporary if invalid == 'temporary' else tmp_path) / 'private-synthetic-sentinel.db'
        monkeypatch.setenv('WENYAN_DATABASE_URL', 'sqlite:///' + path.as_posix())
        if invalid == 'vercel':
            monkeypatch.setenv('VERCEL', '1')
    called = []
    def forbidden_db():
        called.append(True)
        raise AssertionError('DB dependency must not run')
    monkeypatch.setitem(app.dependency_overrides, get_db, forbidden_db)
    client = TestClient(app)
    for path in ('/api/health', '/api/v1/lessons'):
        response = client.get(path)
        assert response.status_code == 503
        assert response.headers['cache-control'] == 'no-store'
        assert response.json() == {'error': {'code': 'ACCESS_CONFIGURATION_INVALID'}}
        assert 'sentinel' not in response.text
    assert not called


def test_no_lifespan_valid_persistent_path_and_local_mode_are_usable(monkeypatch, tmp_path):
    settings = SimpleNamespace(production=True, mode='invite', admin_enabled=False, allowed_origins=('https://testserver',))
    monkeypatch.setattr(access, 'load_access_settings', lambda: settings)
    monkeypatch.setattr(preflight, '_temporary_roots', lambda: [(tmp_path / 'another-synthetic-temp').resolve()])
    monkeypatch.delenv('VERCEL', raising=False)
    database = tmp_path / 'synthetic-persistent.sqlite'
    monkeypatch.setenv('WENYAN_DATABASE_URL', 'sqlite:///' + database.as_posix())
    assert TestClient(app).get('/api/health').status_code == 200
    assert not database.exists()
    settings.production = False
    settings.mode = 'local'
    monkeypatch.setenv('WENYAN_DATABASE_URL', 'sqlite:///:memory:')
    assert TestClient(app).get('/api/health').status_code == 200


def test_storage_oserror_is_sanitized(monkeypatch):
    settings = SimpleNamespace(production=True, mode='invite', admin_enabled=False, allowed_origins=('https://testserver',))
    monkeypatch.setattr(access, 'load_access_settings', lambda: settings)
    def unavailable(_settings):
        raise OSError('synthetic-private-path')
    monkeypatch.setattr(access, 'require_production_storage', unavailable)
    response = TestClient(app).get('/api/health')
    assert response.status_code == 503
    assert response.json() == {'error': {'code': 'ACCESS_CONFIGURATION_INVALID'}}
    assert response.headers['cache-control'] == 'no-store'
    assert 'synthetic-private-path' not in response.text
