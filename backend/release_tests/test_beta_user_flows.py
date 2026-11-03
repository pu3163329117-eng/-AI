"""Real cookie/login + full-app isolation, without any running database or model."""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.auth.models import AuthSession, AuthUser, ProfileOwner, utcnow
from backend.auth.service import COOKIE_NAME, create_invite, token_hash
from backend.db.assessment import seed_assessment_bank
from backend.db.models import LearnerProfile, Lesson, TrainingSession
from backend.db.seed import seed_lessons
from backend.db.session import Base, get_db
from backend.main import app

ORIGIN = 'http://127.0.0.1:8017'
SYNTHETIC_PASSWORD = 'Synthetic-Only-Beta-Password-2026'


@pytest.fixture
def users(monkeypatch):
    for name, value in {'WENYAN_ENV': 'test', 'WENYAN_ACCESS_MODE': 'invite', 'WENYAN_AUTH_ORIGINS': ORIGIN,
                        'WENYAN_AUTH_COOKIE_SECURE': '0', 'WENYAN_ADMIN_ENABLED': '0', 'WENYAN_AI_ENABLED': '0',
                        'WENYAN_COLLABORATION_ENABLED': '0', 'WENYAN_COLLABORATION_REAL_CALLS_ENABLED': '0'}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv('VERCEL', raising=False)
    engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    seed_lessons(db)
    seed_assessment_bank(db)
    db.add(LearnerProfile(id='unclaimed-legacy', display_name='Legacy data retained', school_stage='SENIOR'))
    db.commit()
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    accounts = []
    for name in ('learner-a', 'learner-b'):
        token, _ = create_invite(db, role='learner')
        client = TestClient(app, base_url=ORIGIN, headers={'Origin': ORIGIN, 'X-Wenyan-Training-Contract': 'guided-v1'})
        redeemed = client.post('/api/v1/auth/redeem', json={'invite_code': token, 'username': name, 'password': SYNTHETIC_PASSWORD})
        assert redeemed.status_code == 200
        auth = redeemed.json()
        client.headers['X-CSRF-Token'] = auth['csrf_token']
        result = client.post('/api/v1/profiles', json={'display_name': name, 'school_stage': 'SENIOR'})
        assert result.status_code == 201
        profile_id = result.json()['profile']['id']
        accounts.append((client, auth['user']['id'], profile_id))
        assert client.get('/api/v1/auth/session').json()['profile_id'] == profile_id
    yield db, accounts[0], accounts[1]
    for client, _, _ in accounts:
        client.close()
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    db.close()
    engine.dispose()


def test_real_cookie_users_cannot_read_write_or_replay_each_others_learning(users):
    db, (a, a_user, a_profile), (b, _, b_profile) = users
    lesson = db.scalar(select(Lesson).where(Lesson.school_stage == 'SENIOR', Lesson.status == 'PUBLISHED'))
    created = b.post('/api/v1/training/sessions', json={'profile_id': b_profile, 'lesson_id': lesson.id})
    assert created.status_code == 201
    session_id = created.json()['session_id']
    snapshot = created.json()['session']
    assert not {'correct_answer', 'hint_ladder', 'transfer_content', 'lesson_summary', 'validated_feedback'} & set(snapshot)
    assert snapshot['evidence'] == ''
    command = {'type': 'DEFER_VARIABLE', 'expected_state_version': snapshot['state_version'], 'payload': {}}
    first = b.post(f'/api/v1/training/sessions/{session_id}/commands', json=command, headers={'Idempotency-Key': 'shared-synthetic-key'})
    assert first.status_code == 200
    version = first.json()['state_version']
    assert 'correct_answer' not in first.json()['session']
    replay = b.post(f'/api/v1/training/sessions/{session_id}/commands', json=command, headers={'Idempotency-Key': 'shared-synthetic-key'})
    assert replay.status_code == 200 and 'correct_answer' not in replay.json()['session']
    # Stored server snapshots and receipts retain the frozen grading data.
    assert db.get(TrainingSession, session_id).snapshot['correct_answer']
    for path in [f'/api/v1/profiles/{b_profile}', f'/api/v1/profiles/{b_profile}/observations/report',
                 f'/api/v1/training/sessions/{session_id}', f'/api/v1/training/sessions/{session_id}/reasoning',
                 f'/api/knowledge/lookup?session_id={session_id}&paragraph_index=0&start=0&end=1']:
        assert a.get(path).status_code == 404
    # The same receipt key must not bypass ownership or return the other user's receipt.
    denied = a.post(f'/api/v1/training/sessions/{session_id}/commands', json=command, headers={'Idempotency-Key': 'shared-synthetic-key', 'X-User-Id': a_user, 'X-Role': 'admin'})
    assert denied.status_code == 404
    assert db.get(TrainingSession, session_id).state_version == version
    assert a.post('/api/v1/training/sessions', json={'profile_id': b_profile}).status_code == 404
    assert a.get('/api/v1/profiles/' + a_profile).status_code == 200
    assert a.get('/api/v1/profiles/unclaimed-legacy').status_code == 404
    assert db.get(ProfileOwner, 'unclaimed-legacy') is None


def test_real_cookie_assessment_and_admin_boundary(users):
    _, (a, _, _), (b, _, b_profile) = users
    created = b.post('/api/v1/assessments', json={'profile_id': b_profile, 'mode': 'PILOT'})
    assert created.status_code in {200, 201}
    assessment = created.json()['assessment']
    assessment_id = assessment['id']
    assert a.get(f'/api/v1/assessments/{assessment_id}').status_code == 404
    assert a.post(f'/api/v1/assessments/{assessment_id}/commands', json={'type': 'ABANDON_ASSESSMENT', 'expected_state_version': assessment['state_version'], 'payload': {}}, headers={'Idempotency-Key': 'foreign-assessment-key'}).status_code == 404
    assert a.get('/api/v1/admin/lessons').status_code == 404
    assert a.get('/api/v1/admin/knowledge/annotations?document=any').status_code == 404
    assert a.get('/api/v1/collaboration/runs/any').status_code == 404


def test_logout_revocation_expiry_and_login_restore_are_server_authoritative(users):
    db, (a, user_id, profile_id), _ = users
    old_cookie = a.cookies.get(COOKIE_NAME)
    assert old_cookie and a.post('/api/v1/auth/logout').status_code == 200
    attacker = TestClient(app, base_url=ORIGIN, headers={'Origin': ORIGIN, 'X-Wenyan-Training-Contract': 'guided-v1'})
    attacker.cookies.set(COOKIE_NAME, old_cookie)
    assert attacker.get('/api/v1/profiles/' + profile_id).status_code == 401
    logged_in = a.post('/api/v1/auth/login', json={'username': 'learner-a', 'password': SYNTHETIC_PASSWORD})
    assert logged_in.status_code == 200 and logged_in.json()['profile_id'] == profile_id
    assert logged_in.json()['user']['id'] == user_id
    assert a.cookies.get(COOKIE_NAME) != old_cookie
    assert a.get('/api/v1/profiles/' + profile_id).status_code == 200
    record = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash(a.cookies.get(COOKIE_NAME))))
    record.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert a.get('/api/v1/auth/session').json()['authenticated'] is False
    assert a.get('/api/v1/profiles/' + profile_id).status_code == 401
    assert db.get(AuthUser, user_id).disabled is False
    attacker.close()


def test_auth_validation_does_not_echo_submitted_credentials(users):
    client = users[1][0]
    sensitive = 'Synthetic-password-value-' * 10
    response = client.post('/api/v1/auth/login', json={'username': 'learner-a', 'password': sensitive})
    assert response.status_code == 422
    assert response.json() == {'error': {'code': 'AUTH_INVALID_INPUT'}}
    assert sensitive not in response.text
