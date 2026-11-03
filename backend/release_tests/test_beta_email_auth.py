"""Synthetic email proofs only. No real mail provider or learning DB is accessed."""
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request
from sqlalchemy import create_engine, select, update
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.auth import email_service
from backend.auth.models import AuthAttempt, AuthEmailChallenge, AuthInvite, AuthSession, AuthUser, ProfileOwner, utcnow
from backend.auth.routes import router
from backend.auth.service import COOKIE_NAME, create_invite
from backend.auth.settings import AccessSettings, load_access_settings
from backend.db import models as _models  # noqa
from backend.db.session import Base, get_db

ORIGIN = "http://127.0.0.1:5173"
REAL_SEND_CODE = email_service.send_code


@pytest.fixture
def email_app(monkeypatch):
    for key, value in {"WENYAN_ENV": "test", "WENYAN_ACCESS_MODE": "invite", "WENYAN_AUTH_LOGIN_METHOD": "email_code",
            "WENYAN_AUTH_EMAIL_PROVIDER": "mock", "WENYAN_AUTH_OTP_SECRET": "synthetic-only-otp-secret-32-characters-minimum",
            "WENYAN_AUTH_ORIGINS": ORIGIN, "WENYAN_AUTH_COOKIE_SECURE": "0", "WENYAN_AI_ENABLED": "0",
            "WENYAN_COLLABORATION_ENABLED": "0", "WENYAN_COLLABORATION_REAL_CALLS_ENABLED": "0"}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("WENYAN_AUTH_EMAIL_DAILY_LIMIT", raising=False)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    app = FastAPI()
    app.include_router(router)
    def dependency():
        with factory() as db:
            yield db
    app.dependency_overrides[get_db] = dependency
    sent = []
    monkeypatch.setattr(email_service, "send_code", lambda config, request, email, code, challenge_id: sent.append((email, code, challenge_id)))
    with TestClient(app, base_url="http://127.0.0.1", headers={"Origin": ORIGIN}) as client:
        yield client, factory, sent
    engine.dispose()


def invite(factory, email=None):
    with factory() as db:
        code, row = create_invite(db, role="learner", email=email)
        return code, row.id


def request(client, email="learner@example.com", purpose="register", invite_code=None):
    body = {"email": email, "purpose": purpose}
    if invite_code:
        body["invite_code"] = invite_code
    return client.post("/api/v1/auth/email/request", json=body)


def verify(client, challenge_id, code, invite_code=None, email="learner@example.com"):
    body = {"email": email, "challenge_id": challenge_id, "code": code}
    if invite_code:
        body["invite_code"] = invite_code
    return client.post("/api/v1/auth/email/verify", json=body)


def release_cooldown(factory):
    with factory() as db:
        db.execute(update(AuthAttempt).where(AuthAttempt.key.startswith("cooldown:")).values(expires_at=utcnow()-timedelta(seconds=1)))
        db.commit()


def test_register_login_rotates_cookie_and_never_claims_legacy(email_app):
    client, factory, sent = email_app
    invitation, invitation_id = invite(factory, "Learner@Example.com")
    assert client.get("/api/v1/auth/session").json()["login_method"] == "email_code"
    result = request(client, email=" LEARNER@example.com ", invite_code=invitation)
    assert result.status_code == 200
    assert set(result.json()) == {"ok", "challenge_id", "expires_in_seconds", "resend_after_seconds"}
    challenge_id = result.json()["challenge_id"]
    with factory() as db:
        assert db.get(AuthInvite, invitation_id).used_at is None
        row = db.get(AuthEmailChallenge, challenge_id)
        assert row.code_digest != sent[-1][1] and sent[-1][1] not in row.code_digest
    result = verify(client, challenge_id, sent[-1][1], invitation)
    assert result.status_code == 200, result.text
    assert result.json()["user"]["email"] == "learner@example.com"
    assert result.json()["profile_id"] is None
    old_token = client.cookies.get(COOKIE_NAME)
    with factory() as db:
        assert db.get(AuthInvite, invitation_id).used_at
        assert db.get(AuthEmailChallenge, challenge_id).consumed_at
        assert not db.scalars(select(ProfileOwner)).all()
    assert verify(client, challenge_id, sent[-1][1], invitation).status_code == 400
    release_cooldown(factory)
    result = request(client, purpose="login")
    assert result.status_code == 200
    result = verify(client, result.json()["challenge_id"], sent[-1][1])
    assert result.status_code == 200 and client.cookies.get(COOKIE_NAME) != old_token
    with factory() as db:
        sessions = db.scalars(select(AuthSession)).all()
        assert len(sessions) == 2 and sum(s.revoked_at is not None for s in sessions) == 1


@pytest.mark.parametrize("kind", ["unknown_login", "bad_invite", "bound_elsewhere", "expired_invite", "revoked_invite"])
def test_invalid_request_is_decoy_without_account_enumeration(email_app, kind):
    client, factory, sent = email_app
    invitation, invitation_id = invite(factory, "other@example.com" if kind == "bound_elsewhere" else None)
    if kind in {"expired_invite", "revoked_invite"}:
        with factory() as db:
            row = db.get(AuthInvite, invitation_id)
            setattr(row, "expires_at" if kind == "expired_invite" else "revoked_at", utcnow()-timedelta(seconds=1))
            db.commit()
    result = request(client, purpose="login" if kind == "unknown_login" else "register", invite_code="wrong-invitation-value" if kind == "bad_invite" else invitation)
    assert result.status_code == 200 and not sent
    assert result.json()["ok"] is True
    result = verify(client, result.json()["challenge_id"], "000000", invitation)
    assert result.status_code == 400 and result.json()["detail"]["code"] == "AUTH_EMAIL_CODE_INVALID"
    with factory() as db:
        assert not db.scalars(select(AuthUser)).all()
        assert db.get(AuthInvite, invitation_id).used_at is None


@pytest.mark.parametrize("state", ["expired", "revoked", "wrong_email", "wrong_invite"])
def test_proof_context_and_expiry(email_app, state):
    client, factory, sent = email_app
    invitation, invitation_id = invite(factory)
    result = request(client, invite_code=invitation)
    challenge_id = result.json()["challenge_id"]
    if state in {"expired", "revoked"}:
        with factory() as db:
            row = db.get(AuthEmailChallenge, challenge_id)
            setattr(row, "expires_at" if state == "expired" else "revoked_at", utcnow()-timedelta(seconds=1))
            db.commit()
    result = verify(client, challenge_id, sent[-1][1], "different-invitation-value" if state == "wrong_invite" else invitation,
                    email="other@example.com" if state == "wrong_email" else "learner@example.com")
    assert result.status_code == 400
    with factory() as db:
        assert db.get(AuthInvite, invitation_id).used_at is None


def test_five_wrong_codes_lock_even_the_correct_code(email_app):
    client, factory, sent = email_app
    invitation, _ = invite(factory)
    challenge_id = request(client, invite_code=invitation).json()["challenge_id"]
    wrong = "111111" if sent[-1][1] != "111111" else "222222"
    for _ in range(5):
        assert verify(client, challenge_id, wrong, invitation).status_code == 400
    assert verify(client, challenge_id, sent[-1][1], invitation).status_code == 400
    with factory() as db:
        assert db.get(AuthEmailChallenge, challenge_id).attempts == 5


def test_cooldown_persists_and_resend_invalidates_old_proof(email_app):
    client, factory, sent = email_app
    invitation, _ = invite(factory)
    old_id = request(client, invite_code=invitation).json()["challenge_id"]
    old_code = sent[-1][1]
    again = request(client, invite_code=invitation)
    assert again.status_code == 429 and again.headers["retry-after"] == "60"
    release_cooldown(factory)
    assert request(client, invite_code=invitation).status_code == 200
    assert verify(client, old_id, old_code, invitation).status_code == 400


def test_provider_failure_is_not_fake_success_and_never_consumes_invite(email_app, monkeypatch):
    client, factory, sent = email_app
    invitation, invitation_id = invite(factory)
    def fail(*args):
        raise TimeoutError("synthetic provider timeout")
    monkeypatch.setattr(email_service, "send_code", fail)
    result = request(client, invite_code=invitation)
    assert result.status_code == 503 and result.json()["detail"]["code"] == "AUTH_EMAIL_UNAVAILABLE"
    with factory() as db:
        row = db.scalar(select(AuthEmailChallenge))
        assert row.revoked_at and row.sent_at is None
        assert db.get(AuthInvite, invitation_id).used_at is None


def test_password_routes_disabled_origin_required_and_no_code_echo(email_app):
    client, factory, sent = email_app
    invitation, _ = invite(factory)
    assert client.post("/api/v1/auth/login", json={"username": "learner", "password": "synthetic-password"}).status_code == 404
    assert client.post("/api/v1/auth/redeem", json={"username": "learner", "password": "synthetic-password", "invite_code": invitation}).status_code == 404
    assert request(client, email="bad-email", invite_code=invitation).status_code == 422
    client.headers["Origin"] = "https://attacker.example"
    assert request(client, invite_code=invitation).status_code == 403
    assert not sent


def test_decoys_do_not_exhaust_daily_budget_and_budget_is_not_an_identity_oracle(email_app, monkeypatch):
    client, factory, sent = email_app
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_DAILY_LIMIT", "1")
    # Arbitrary unknown addresses cannot consume the real provider-send budget.
    assert request(client, email="unknown@example.com", purpose="login").status_code == 200
    first_invitation, _ = invite(factory, "first@example.com")
    assert request(client, email="first@example.com", invite_code=first_invitation).status_code == 200
    assert len(sent) == 1
    second_invitation, _ = invite(factory, "second@example.com")
    client.headers["X-Forwarded-For"] = "198.51.100.2"
    result = request(client, email="second@example.com", invite_code=second_invitation)
    assert result.status_code == 200 and len(sent) == 1
    assert verify(client, result.json()["challenge_id"], "000000", second_invitation,
                  email="second@example.com").status_code == 400


def test_mock_and_missing_provider_configuration_fail_closed(email_app, monkeypatch):
    client, factory, sent = email_app
    monkeypatch.setenv("WENYAN_AUTH_OTP_SECRET", "too-short")
    with pytest.raises(ValueError, match="OTP secret"):
        load_access_settings()
    monkeypatch.setenv("WENYAN_AUTH_OTP_SECRET", "x"*32)
    with pytest.raises(ValueError, match="prohibited"):
        email_service.email_configuration(AccessSettings("invite", True, False, ("https://example.com",), True, "email_code"))
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_PROVIDER", "resend")
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_FROM", "auth@example.com")
    with pytest.raises(ValueError, match="Resend API key"):
        load_access_settings()






@pytest.mark.parametrize("variable,value", [
    ("WENYAN_AUTH_OTP_SECRET", "REPLACE_WITH_UNIQUE_RANDOM_SECRET_AT_LEAST_32_BYTES"),
    ("RESEND_API_KEY", "re_REPLACE_WITH_PRIVATE_SENDING_KEY"),
    ("WENYAN_AUTH_EMAIL_FROM", "login@auth.example.test"),
])
def test_production_rejects_committed_email_placeholders(email_app, monkeypatch, variable, value):
    monkeypatch.setenv("WENYAN_ENV", "production")
    monkeypatch.setenv("WENYAN_AUTH_ORIGINS", "https://beta.wenyan.cn")
    monkeypatch.setenv("WENYAN_AUTH_COOKIE_SECURE", "1")
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_PROVIDER", "resend")
    monkeypatch.setenv("WENYAN_AUTH_OTP_SECRET", "synthetic-private-production-secret-32-plus")
    monkeypatch.setenv("RESEND_API_KEY", "re_syntheticprivatekey123456789")
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_FROM", "synthetic-test-user@synthetic-test-host.onion")
    monkeypatch.setenv(variable, value)
    with pytest.raises(ValueError, match="non-placeholder"):
        load_access_settings()


def test_production_accepts_well_formed_private_email_configuration(email_app, monkeypatch):
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_PROVIDER", "resend")
    monkeypatch.setenv("WENYAN_AUTH_OTP_SECRET", "private-production-secret-8d311c5fb69246ec")
    monkeypatch.setenv("RESEND_API_KEY", "re_8d311c5fb69246ec91276543")
    monkeypatch.setenv("WENYAN_AUTH_EMAIL_FROM", "synthetic-test-user@synthetic-test-host.onion")
    config = email_service.email_configuration(
        AccessSettings("invite", True, False, ("https://beta.wenyan.cn",), True, "email_code"))
    assert config.provider == "resend" and config.sender == "synthetic-test-user@synthetic-test-host.onion"


def test_secret_hmac_is_bound_to_email_purpose_challenge(email_app):
    config = email_service.email_configuration(load_access_settings())
    baseline = email_service._digest(config, "id", "a@example.com", "login", "123456")
    assert baseline != email_service._digest(config, "id2", "a@example.com", "login", "123456")
    assert baseline != email_service._digest(config, "id", "b@example.com", "login", "123456")
    assert baseline != email_service._digest(config, "id", "a@example.com", "register", "123456")
    assert config.secret.decode() not in repr(config)


def test_mock_proof_verification_rejects_nonloopback_even_with_valid_code(email_app):
    client, factory, sent = email_app
    invitation, _ = invite(factory)
    challenge_id = request(client, invite_code=invitation).json()["challenge_id"]
    outside = Request({"type": "http", "method": "POST", "headers": [], "client": ("198.51.100.4", 1234)})
    with factory() as db, pytest.raises(HTTPException) as error:
        email_service.consume_proof(db, outside, load_access_settings(), "learner@example.com", challenge_id, sent[-1][1], invitation)
    assert error.value.status_code == 503


@pytest.mark.parametrize("change", ["revoked", "rebound"])
def test_invite_revalidated_at_final_verification(email_app, change):
    client, factory, sent = email_app
    invitation, invitation_id = invite(factory)
    challenge_id = request(client, invite_code=invitation).json()["challenge_id"]
    with factory() as db:
        row = db.get(AuthInvite, invitation_id)
        if change == "revoked":
            row.revoked_at = utcnow()
        else:
            row.email = "changed@example.com"
        db.commit()
    assert verify(client, challenge_id, sent[-1][1], invitation).status_code == 400
    with factory() as db:
        assert not db.scalars(select(AuthUser)).all()


def test_disabled_user_receives_decoy_and_cannot_reenter(email_app):
    client, factory, sent = email_app
    invitation, _ = invite(factory)
    challenge_id = request(client, invite_code=invitation).json()["challenge_id"]
    assert verify(client, challenge_id, sent[-1][1], invitation).status_code == 200
    release_cooldown(factory)
    with factory() as db:
        db.scalar(select(AuthUser)).disabled = True
        db.commit()
    count = len(sent)
    challenge_id = request(client, purpose="login").json()["challenge_id"]
    assert len(sent) == count
    assert verify(client, challenge_id, sent[-1][1]).status_code == 400
    assert not client.get("/api/v1/auth/session").json()["authenticated"]


def test_same_proof_concurrently_consumed_only_once(email_app, tmp_path):
    client, factory, sent = email_app
    # File SQLite provides real independent transactions, unlike StaticPool.
    database = tmp_path / "email-concurrency.db"
    engine = create_engine(f"sqlite:///{database}", connect_args={"check_same_thread": False, "timeout": 15})
    Base.metadata.create_all(engine)
    independent = sessionmaker(engine, expire_on_commit=False)
    invitation, _ = invite(independent)
    req = Request({"type": "http", "method": "POST", "headers": [], "client": ("127.0.0.1", 1234)})
    settings = load_access_settings()
    with independent() as db:
        proof = email_service.request_proof(db, req, settings, "learner@example.com", "register", invitation)
    code = sent[-1][1]
    def consume():
        with independent() as db:
            try:
                user = email_service.consume_proof(db, req, settings, "learner@example.com", proof["challenge_id"], code, invitation)
                db.commit()
                return user.id
            except HTTPException as error:
                return error.status_code
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: consume(), range(2)))
    assert sum(isinstance(value, str) for value in results) == 1 and 400 in results
    with independent() as db:
        assert len(db.scalars(select(AuthUser)).all()) == 1
    engine.dispose()


def test_resend_adapter_bounded_json_and_no_redirects(email_app, monkeypatch):
    monkeypatch.setattr(email_service, "send_code", REAL_SEND_CODE)
    config = email_service.EmailConfiguration("resend", b"x"*32, "auth@example.com", "synthetic-api-key", 80)
    req = Request({"type": "http", "method": "POST", "headers": [], "client": ("127.0.0.1", 1234)})
    calls = []
    class Receipt:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): return None
        def read(self, maximum):
            assert maximum == 65536
            return b'{"id":"synthetic-delivery-id"}'
    class Opener:
        def open(self, outgoing, timeout):
            calls.append((outgoing, timeout))
            return Receipt()
    monkeypatch.setattr(email_service.urllib.request, "build_opener", lambda redirect: Opener())
    email_service.send_code(config, req, "learner@example.com", "123456", "synthetic-challenge")
    outgoing, timeout = calls[0]
    assert outgoing.full_url == "https://api.resend.com/emails" and timeout == 5
    assert b"123456" in outgoing.data and b"synthetic-api-key" not in outgoing.data
