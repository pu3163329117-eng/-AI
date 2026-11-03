"""Adversarial ownership/route-policy tests in an isolated in-memory database."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import backend.access as access
from backend.db.assessment_models import AssessmentSession
from backend.db.models import LearnerProfile, TrainingSession
from backend.db.session import Base, get_db
from backend.main import app
from backend.auth.models import ProfileOwner


@pytest.fixture
def beta(monkeypatch):
    engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    # Authentication itself has independent real-cookie tests. Isolate this layer
    # so every resource route can be attacked without repeated expensive password hashes.
    identity = SimpleNamespace(id='user-a', role='learner')
    settings = SimpleNamespace(mode='invite', admin_enabled=False, allowed_origins=('http://testserver',), production=False)
    monkeypatch.setattr(access, 'load_access_settings', lambda: settings)
    monkeypatch.setattr(access, 'current_session', lambda *args: (identity, SimpleNamespace()) if identity.id else None)
    def csrf(request, *_):
        if request.headers.get('X-CSRF-Token') != 'synthetic-csrf':
            raise HTTPException(403, {'code': 'CSRF_REJECTED'})
    monkeypatch.setattr(access, 'require_csrf', csrf)
    for profile_id, user_id in [('profile-a', 'user-a'), ('profile-b', 'user-b')]:
        session.add(LearnerProfile(id=profile_id, display_name=profile_id, school_stage='SENIOR'))
        session.add(ProfileOwner(profile_id=profile_id, user_id=user_id))
    session.add(LearnerProfile(id='legacy', display_name='Unclaimed legacy', school_stage='SENIOR'))
    session.add(TrainingSession(id='foreign-training', profile_id='profile-b', lesson_id=None, state_version=0, snapshot={'private': 'foreign learner secret'}))
    session.add(AssessmentSession(id='foreign-assessment', profile_id='profile-b', mode='PILOT', status='IN_PROGRESS', state_version=0, snapshot={'private': 'foreign assessment secret'}))
    session.commit()
    def override():
        yield session
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override
    client = TestClient(app, headers={'Origin': 'http://testserver', 'X-CSRF-Token': 'synthetic-csrf', 'X-Wenyan-Training-Contract': 'guided-v1'})
    yield client, session, settings, identity
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    session.close()
    engine.dispose()


@pytest.mark.parametrize('suffix', ['', '/learning-summary', '/daily-mission', '/practice-plans', '/achievements', '/mistakes', '/sessions', '/assessments', '/ability', '/recommendations', '/observations/report'])
def test_every_profile_read_rejects_foreign_and_unclaimed(beta, suffix):
    client, *_ = beta
    for target in ('profile-b', 'legacy', 'missing'):
        response = client.get('/api/v1/profiles/' + target + suffix)
        assert response.status_code == 404
        assert response.json() == {'error': {'code': 'RESOURCE_NOT_FOUND'}}


def test_own_profile_allowed_and_anonymous_denied(beta):
    client, _, _, identity = beta
    own = client.get('/api/v1/profiles/profile-a')
    assert own.status_code == 200 and own.json()['profile']['id'] == 'profile-a'
    assert own.headers['cache-control'] == 'no-store'
    identity.id = None
    assert client.get('/api/v1/lessons').status_code == 401
    assert client.get('/api/v1/profiles/profile-a').status_code == 401


@pytest.mark.parametrize('path', ['/api/v1/training/sessions/foreign-training', '/api/v1/training/sessions/foreign-training/reasoning', '/api/v1/assessments/foreign-assessment', '/api/knowledge/lookup?session_id=foreign-training&paragraph_index=0&start=0&end=1', '/api/v1/lessons/next?school_stage=SENIOR&profile_id=profile-b'])
def test_id_and_query_based_reads_cannot_cross_users(beta, path):
    response = beta[0].get(path)
    assert response.status_code == 404
    assert 'secret' not in response.text


@pytest.mark.parametrize(('path', 'payload'), [
    ('/api/v1/training/sessions', {'profile_id': 'profile-b'}),
    ('/api/v1/assessments', {'profile_id': 'profile-b', 'mode': 'PILOT'}),
    ('/api/v1/training/sessions/foreign-training/commands', {'type': 'DEFER_VARIABLE', 'expected_state_version': 0, 'payload': {}}),
    ('/api/v1/assessments/foreign-assessment/commands', {'type': 'ABANDON_ASSESSMENT', 'expected_state_version': 0, 'payload': {}}),
    ('/api/v1/profiles/profile-b/recommendations', {}),
])
def test_foreign_mutations_rejected_before_handler_or_receipt(beta, path, payload):
    client, db, *_ = beta
    before = db.get(TrainingSession, 'foreign-training').snapshot.copy()
    response = client.post(path, json=payload, headers={'Idempotency-Key': 'same-key-as-another-user'})
    assert response.status_code == 404
    assert db.get(TrainingSession, 'foreign-training').snapshot == before


def test_mutations_need_csrf_and_existing_profile_cannot_be_duplicated(beta):
    client, db, *_ = beta
    payload = {'display_name': 'New profile', 'school_stage': 'SENIOR'}
    response = client.post('/api/v1/profiles', json=payload, headers={'X-CSRF-Token': ''})
    assert response.status_code == 403
    response = client.post('/api/v1/profiles', json=payload)
    assert response.status_code == 409
    assert db.scalar(select(ProfileOwner).where(ProfileOwner.user_id == 'user-a')).profile_id == 'profile-a'
    assert db.get(LearnerProfile, 'legacy').display_name == 'Unclaimed legacy'


def test_new_profile_ownership_is_atomic_and_never_claims_legacy(beta):
    client, db, _, identity = beta
    identity.id = 'new-user'
    response = client.post('/api/v1/profiles', json={'display_name': '内测新用户', 'school_stage': 'JUNIOR'})
    assert response.status_code == 201
    profile_id = response.json()['profile']['id']
    assert db.get(ProfileOwner, profile_id).user_id == 'new-user'
    assert db.get(ProfileOwner, 'legacy') is None
    assert client.get('/api/v1/profiles/' + profile_id).status_code == 200
    assert client.get('/api/v1/profiles/profile-a').status_code == 404


@pytest.mark.parametrize('path', ['/api/v1/admin/lessons', '/api/v1/admin/knowledge/annotations?document=any', '/api/v1/admin/assessment/questions'])
def test_admin_api_enforced_independently_of_navigation(beta, path):
    client, _, settings, identity = beta
    assert client.get(path).status_code == 404
    settings.admin_enabled = True
    assert client.get(path).status_code == 403
    identity.role = 'admin'
    assert client.get('/api/v1/admin/lessons').status_code == 200
    assert client.get('/api/v1/profiles/profile-b').status_code == 404


def test_disabled_tools_docs_and_spoofed_host(beta):
    client, *_ = beta
    for path in ['/docs', '/openapi.json', '/redoc', '/api/v1/collaboration/runs/any', '/api/v1/admin/ai-reason-review/cases']:
        assert client.get(path).status_code == 404
    assert client.get('/api/v1/profiles/profile-a', headers={'Host': 'attacker.example'}).status_code == 400


def test_new_api_routes_fail_closed(beta):
    client, *_ = beta
    prior_routes = list(app.router.routes)
    try:
        app.add_api_route('/api/v1/unclassified-private-data', lambda: {'secret': 'must not return'})
        response = client.get('/api/v1/unclassified-private-data')
        assert response.status_code == 403
    finally:
        app.router.routes[:] = prior_routes


def test_all_registered_api_routes_have_a_policy_and_global_guard():
    assert_api_structure_matches_openapi(app)
    assert_api_operations_classified(app.openapi())


def is_api_path(path):
    return path == '/api' or path.startswith('/api/')


def assert_api_structure_matches_openapi(application):
    from fastapi.routing import APIRoute
    from starlette.routing import Mount
    registered = set()
    for entry in application.routes:
        if isinstance(entry, APIRoute):
            contexts = [entry]
        elif callable(getattr(entry, 'effective_route_contexts', None)):
            # FastAPI 0.142+ retains included routers as wrappers. Effective
            # contexts resolve prefixes and inherited dependencies recursively.
            contexts = entry.effective_route_contexts()
        else:
            assert not isinstance(entry, Mount), 'Mounted applications require a separate route audit'
            assert not is_api_path(getattr(entry, 'path', '')), 'Unsupported API route type'
            continue
        for route in contexts:
            if not is_api_path(route.path):
                continue
            assert route.include_in_schema, ('API route hidden from schema', route.path)
            assert any(dependency.call is access.authorize_request for dependency in route.dependant.dependencies), route.path
            for method in route.methods:
                operation = (method, route.path)
                assert operation not in registered, ('Duplicate API operation', operation)
                registered.add(operation)
    documented = {(method.upper(), path) for path, operations in application.openapi()['paths'].items()
                  if is_api_path(path) for method in operations
                  if method.upper() in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'}}
    assert registered and registered == documented, (registered - documented, documented - registered)


def assert_api_operations_classified(schema):
    known = access.CONTENT_ROUTES | access.ACCOUNT_ROUTES | access.PROFILE_ROUTES | access.TRAINING_ROUTES | access.ASSESSMENT_ROUTES | access.CREATION_ROUTES | access.AUTH_ROUTES | {('GET', '/api/health'), ('GET', '/api/knowledge/lookup')}
    methods = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'}
    for path, operations in schema['paths'].items():
        if not is_api_path(path):
            continue
        for name in operations:
            method = name.upper()
            if method not in methods:
                continue
            if path.startswith(('/api/v1/admin/', '/api/v1/collaboration/', '/api/v1/ai/sessions/')):
                continue
            assert (method, path) in known, (method, path)


def assert_global_guard_runs_for_operations(client, schema, calls):
    import re
    methods = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'}
    checked = 0
    for path, operations in schema['paths'].items():
        if not is_api_path(path):
            continue
        url = re.sub(r'\{[^}]+\}', '00000000-0000-0000-0000-000000000001', path)
        for name in operations:
            method = name.upper()
            if method not in methods:
                continue
            calls.clear()
            response = client.request(method, url, json={} if method not in {'GET', 'HEAD'} else None)
            assert response.status_code == 418, (method, path, response.status_code)
            assert calls == [(method, path)], (method, path, calls)
            checked += 1
    assert checked > 0


def test_global_guard_executes_on_every_openapi_operation(beta, monkeypatch):
    client, *_ = beta
    calls = []
    def guard_probe(request, db, route, policy, body):
        calls.append((policy[0], route))
        raise HTTPException(418, {'code': 'SYNTHETIC_GUARD_PROBE'})
    monkeypatch.setattr(access, '_authorize_and_release', guard_probe)
    assert_global_guard_runs_for_operations(client, app.openapi(), calls)


def test_route_audit_rejects_unclassified_included_router():
    from fastapi import APIRouter, FastAPI
    candidate = FastAPI()
    router = APIRouter(prefix='/api/v1')
    router.add_api_route('/unclassified-synthetic', lambda: {}, methods=['GET'])
    candidate.include_router(router)
    with pytest.raises(AssertionError, match='unclassified-synthetic'):
        assert_api_operations_classified(candidate.openapi())


def test_guard_audit_rejects_unguarded_included_router():
    from fastapi import APIRouter, FastAPI
    candidate = FastAPI()
    router = APIRouter(prefix='/api/v1')
    router.add_api_route('/unprotected-synthetic', lambda: {}, methods=['GET'])
    candidate.include_router(router)
    with pytest.raises(AssertionError):
        assert_api_structure_matches_openapi(candidate)
    with TestClient(candidate) as client, pytest.raises(AssertionError):
        assert_global_guard_runs_for_operations(client, candidate.openapi(), [])


def test_route_audit_rejects_hidden_included_router():
    from fastapi import APIRouter, Depends, FastAPI
    candidate = FastAPI(dependencies=[Depends(access.authorize_request)])
    router = APIRouter(prefix='/api/v1')
    router.add_api_route('/hidden-synthetic', lambda: {}, methods=['GET'], include_in_schema=False)
    candidate.include_router(router)
    with pytest.raises(AssertionError, match='hidden from schema'):
        assert_api_structure_matches_openapi(candidate)
