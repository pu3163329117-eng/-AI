"""Protected inbox HTTP tests; fresh synthetic SQLite and real access/CSRF.

Run only from the public-source copied QA workspace, never the user database.
No emails, invitations, passwords, or production sessions are read or sent.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import re
import sqlite3
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import sessionmaker

import backend.access as access
import backend.support_admin_access as support_access
import backend.support_admin_routes as routes
from backend.auth import service as auth
from backend.auth.models import AuthSession, AuthUser, utcnow
from backend.db.experience_models import SupportFeedback, SupportReply
from backend.db.session import Base, get_db
from backend.main import app
from backend.release_tests import beta_support_fixture as cli

BASE = routes.PREFIX
MESSAGE = "您好，合成手机按钮问题已经记录，请使用这一轮测试页面复核。"
META = {"id", "reference", "kind", "category", "page", "build_version", "status", "created_at", "updated_at"}


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    path = tmp_path / "synthetic-inbox.sqlite"
    engine = create_engine("sqlite:///" + path.as_posix(), connect_args={"check_same_thread": False, "timeout": 15})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    settings = SimpleNamespace(mode="invite", admin_enabled=False, allowed_origins=("http://testserver",), production=False,
                               cookie_secure=False, login_method="password")
    tokens = {"admin": "a" * 43, "learner-a": "b" * 43, "learner-b": "c" * 43}
    csrf = {role: ("synthetic-csrf-" + role) for role in tokens}
    with factory() as db:
        for name, token in tokens.items():
            db.add(AuthUser(id=name, username="synthetic-" + name, email="owner@demo.test" if name == "admin" else name + "@example.invalid",
                            password_hash="unused-synthetic", role="admin" if name == "admin" else "learner"))
            db.add(AuthSession(id=str(uuid4()), token_hash=auth.token_hash(token), user_id=name,
                               csrf_token=csrf[name], expires_at=utcnow() + timedelta(hours=1)))
        db.commit()
    monkeypatch.setattr(access, "load_access_settings", lambda: settings)
    monkeypatch.setattr(routes, "load_access_settings", lambda: settings)
    monkeypatch.setattr(support_access, "load_access_settings", lambda: settings)
    monkeypatch.setenv("WENYAN_SUPPORT_ADMIN_ENABLED", "1")
    monkeypatch.setenv("WENYAN_SUPPORT_OWNER_EMAIL", "owner@demo.test")
    # No current_session/require_csrf override: the normal cookie, role, expiry,
    # origin, and CSRF checks run against synthetic auth tables on every request.
    def override():
        with factory() as db:
            yield db
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override
    def client(role="admin"):
        result = TestClient(app, headers={"Origin": "http://testserver", "X-CSRF-Token": csrf.get(role, "")})
        if role in tokens:
            result.cookies.set(auth.COOKIE_NAME, tokens[role])
        return result
    yield SimpleNamespace(path=path, engine=engine, factory=factory, settings=settings, client=client,
                          admin=client(), tokens=tokens, csrf=csrf)
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    engine.dispose()


def seed(inbox, *, number=1, kind="feedback", status="received", user="learner-a", timestamp=None):
    value = str(uuid4())
    now = timestamp or datetime(2026, 10, 25, 8, 9, 10, 123456, timezone.utc)
    with inbox.factory() as db:
        db.add(SupportFeedback(id=value, user_id=user, request_id=str(uuid4()), content_digest="0" * 64,
            reference="WY-" + f"{number:016X}", kind=kind, category="bug", message="合成用户反馈：按钮没有按预期显示，请协助检查。",
            device="合成手机", page="#/practice", build_version="synthetic-local-1", status=status, created_at=now, updated_at=now))
        db.commit()
    return value


def current(inbox, case):
    response = inbox.admin.get(BASE + "/" + case)
    assert response.status_code == 200, response.text
    return response.json()


def body(inbox, case, **overrides):
    return {"request_id": str(uuid4()), "message": MESSAGE,
            "expected_updated_at": current(inbox, case)["item"]["updated_at"], **overrides}


def post_reply(inbox, case, payload=None):
    return inbox.admin.post(BASE + "/" + case + "/reply", json=payload or body(inbox, case))


def post_status(inbox, case, status="in_progress", expected=None):
    return inbox.admin.post(BASE + "/" + case + "/status", json={"status": status,
        "expected_updated_at": expected or current(inbox, case)["item"]["updated_at"]})


def count_replies(inbox, case):
    with inbox.factory() as db:
        return db.execute(text("SELECT COUNT(*) FROM support_replies WHERE feedback_id=:id"), {"id": case}).scalar_one()


def test_real_cookie_gate_learner_and_anonymous_cannot_read_or_write(inbox):
    case = seed(inbox)
    payload = body(inbox, case)
    for name, status, code in (("anonymous", 401, "AUTH_REQUIRED"), ("learner-a", 403, "ADMIN_REQUIRED"), ("learner-b", 403, "ADMIN_REQUIRED")):
        client = inbox.client(name)
        for endpoint in (BASE, BASE + "/" + case):
            result = client.get(endpoint)
            assert result.status_code == status and result.json() == {"error": {"code": code}}
            assert result.headers["cache-control"] == "no-store"
        assert client.post(BASE + "/" + case + "/reply", json=payload).status_code == status
    assert count_replies(inbox, case) == 0


def test_admin_disabled_and_local_enabled_fail_closed(inbox, monkeypatch):
    case = seed(inbox)
    inbox.settings.admin_enabled = False
    monkeypatch.setenv("WENYAN_SUPPORT_ADMIN_ENABLED", "0")
    assert inbox.admin.get(BASE).json() == {"error": {"code": "ADMIN_DISABLED"}}
    assert inbox.admin.get(BASE + "/" + case).status_code == 404
    inbox.settings.admin_enabled = True
    monkeypatch.setenv("WENYAN_SUPPORT_ADMIN_ENABLED", "1")
    inbox.settings.mode = "local"
    assert inbox.admin.get(BASE).json() == {"error": {"code": "AUTH_REQUIRED"}}
    assert inbox.admin.get(BASE + "/" + case).status_code == 401


def test_router_cannot_be_mounted_anonymously_without_global_auth(inbox):
    local = FastAPI()
    local.include_router(routes.router)
    # The router itself still refuses a local-only app with no authenticated
    # request.state, even if a valid-looking Cookie header was supplied.
    result = TestClient(local).get(BASE, headers={"Cookie": auth.COOKIE_NAME + "=" + inbox.tokens["admin"]})
    assert result.status_code == 401
    assert result.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("headers", [{"X-CSRF-Token": ""}, {"X-CSRF-Token": "wrong"}, {"Origin": "https://other.example.invalid"}])
def test_existing_actual_csrf_protects_both_writes(inbox, headers):
    case = seed(inbox)
    for action, payload in (("reply", body(inbox, case)), ("status", {"status": "resolved", "expected_updated_at": current(inbox, case)["item"]["updated_at"]})):
        response = inbox.admin.post(BASE + "/" + case + "/" + action, json=payload, headers=headers)
        assert response.status_code == 403 and response.headers["cache-control"] == "no-store"
    assert count_replies(inbox, case) == 0 and current(inbox, case)["item"]["status"] == "received"


@pytest.mark.parametrize("change", ["expire", "revoke", "disable", "demote"])
def test_existing_session_changes_are_checked_again_for_each_request(inbox, change):
    case = seed(inbox)
    payload = body(inbox, case)
    with inbox.factory() as db:
        session = db.scalar(select(AuthSession).where(AuthSession.user_id == "admin"))
        if change == "expire": session.expires_at = utcnow() - timedelta(seconds=1)
        elif change == "revoke": session.revoked_at = utcnow()
        elif change == "disable": db.get(AuthUser, "admin").disabled = True
        else: db.get(AuthUser, "admin").role = "learner"
        db.commit()
    assert post_reply(inbox, case, payload).status_code == (403 if change == "demote" else 401)
    assert count_replies(inbox, case) == 0


def test_list_exact_metadata_filters_pagination_and_empty_page(inbox):
    cases = [seed(inbox, number=n, kind="privacy" if n % 2 else "feedback", status="resolved" if n == 3 else "received") for n in range(1, 5)]
    first = inbox.admin.get(BASE).json()
    assert set(first) == {"items", "total", "offset", "limit"}
    assert first["total"] == 4 and first["offset"] == 0 and first["limit"] == 20
    assert [row["id"] for row in first["items"]] == sorted(cases, reverse=True)
    for item in first["items"]:
        assert set(item) == META
        assert re.fullmatch(r".*\.[0-9]{6}Z", item["updated_at"])
    for forbidden in ("user_id", "email", "message", "device", "request_id", "content_digest", "example.invalid", "合成用户反馈"):
        assert forbidden not in json.dumps(first, ensure_ascii=False)
    filtered = inbox.admin.get(BASE + "?kind=privacy&status=resolved&reference=WY-0000000000000003").json()
    assert filtered["total"] == 1 and filtered["items"][0]["id"] == cases[2]
    assert inbox.admin.get(BASE + "?kind=feedback&status=resolved").json()["total"] == 0
    assert inbox.admin.get(BASE + "?reference=&kind=&status=").json() == first
    page = inbox.admin.get(BASE + "?offset=1&limit=2").json()
    assert page["total"] == 4 and page["items"] == first["items"][1:3]
    assert inbox.admin.get(BASE + "?offset=10000&limit=50").json() == {"items": [], "total": 4, "offset": 10000, "limit": 50}


@pytest.mark.parametrize("query", ["unknown=1", "limit=1&limit=2", "kind=privacy&kind=", "reference=WY-0000000000000001&reference=",
    "offset=-1", "offset=10001", "limit=0", "limit=51", "offset=1.0", "limit=true", "offset=+1", "offset=01",
    "reference=wy-0000000000000001", "reference=WY-123", "reference='OR1=1", "status=invalid", "kind=invalid"])
def test_invalid_unknown_duplicate_queries_are_rejected_not_widened(inbox, query):
    seed(inbox)
    result = inbox.admin.get(BASE + "?" + query)
    assert result.status_code == 422
    assert result.json() == {"error": {"code": "SUPPORT_ADMIN_INVALID_INPUT"}}
    assert result.headers["cache-control"] == "no-store"


def test_list_and_detail_each_use_one_support_read_snapshot_no_account_learning_join(inbox):
    case = seed(inbox)
    captured = []
    def capture(_conn, _cursor, statement, *_args): captured.append(statement.lower())
    event.listen(inbox.engine, "before_cursor_execute", capture)
    try:
        for endpoint in (BASE, BASE + "/" + case):
            captured.clear()
            assert inbox.admin.get(endpoint).status_code == 200
            support_queries = [query for query in captured if "support_feedback" in query]
            assert len(support_queries) == 1
            assert not any(word in support_queries[0] for word in ("auth_users", "learner_profiles", "training_sessions", "user_id", "email"))
            assert not any(query.lstrip().startswith(("insert", "update", "delete", "create")) for query in captured)
    finally:
        event.remove(inbox.engine, "before_cursor_execute", capture)


def test_read_helpers_do_not_autoflush_pending_changes(inbox):
    case = seed(inbox)
    with inbox.factory() as db:
        db.autoflush = True
        db.add(AuthUser(username="synthetic-pending-invalid"))
        # This intentionally invalid pending object would fail on autoflush.
        # The protected HTTP dependency is covered separately; here verify the
        # read helper itself does not persist unrelated pending state.
        assert routes.get_feedback(case, db)["item"]["id"] == case
        assert routes.list_feedback(db, offset=0, limit=20)["total"] == 1
        db.rollback()
    with inbox.factory() as db:
        assert db.scalar(select(AuthUser).where(AuthUser.username == "synthetic-pending-invalid")) is None


def test_list_snapshot_total_and_items_stay_consistent_with_concurrent_insert(inbox):
    seed(inbox)
    fired = False
    # WAL permits a second connection to commit while the original statement's
    # cursor still owns the old read snapshot.
    with inbox.engine.connect() as conn: conn.execute(text("PRAGMA journal_mode=WAL"))
    def after(_conn, _cursor, statement, *_args):
        nonlocal fired
        if "WITH matching AS" in statement and not fired:
            fired = True
            seed(inbox, number=2)
    event.listen(inbox.engine, "after_cursor_execute", after)
    try:
        result = inbox.admin.get(BASE).json()
    finally:
        event.remove(inbox.engine, "after_cursor_execute", after)
    assert fired and result["total"] == len(result["items"]) == 1
    assert inbox.admin.get(BASE).json()["total"] == 2


def test_detail_exact_contract_no_hidden_fields_and_case_not_found(inbox):
    case = seed(inbox)
    value = current(inbox, case)
    assert set(value) == {"item", "message", "device", "replies"}
    assert set(value["item"]) == META and value["device"] == "合成手机" and value["replies"] == []
    for forbidden in ("user_id", "email", "request_id", "content_digest", "example.invalid"):
        assert forbidden not in json.dumps(value)
    assert inbox.admin.get(BASE + "/" + str(uuid4())).json() == {"error": {"code": "SUPPORT_NOT_FOUND"}}
    assert inbox.admin.get(BASE + "/" + case + "?unknown=1").status_code == 422


@pytest.mark.parametrize("case_id", ["bad", "A" * 36, "00000000000000000000000000000000", "{00000000-0000-0000-0000-000000000000}"])
def test_ids_strict_and_no_reflected_input(inbox, case_id):
    statements = []
    def capture(_conn, _cursor, statement, *_args): statements.append(statement.lower().lstrip())
    event.listen(inbox.engine, "before_cursor_execute", capture)
    try:
        result = inbox.admin.get(BASE + "/" + case_id)
    finally:
        event.remove(inbox.engine, "before_cursor_execute", capture)
    assert result.status_code == 404 and result.json() == {"error": {"code": "SUPPORT_ROUTE_UNAVAILABLE"}}
    assert case_id not in result.text
    assert not any(statement.startswith(("insert", "update", "delete", "create")) for statement in statements)


def test_status_cas_noop_microseconds_and_cli_interoperation(inbox):
    case = seed(inbox)
    original = current(inbox, case)
    assert post_status(inbox, case, "received").json() == original
    # Equivalent timezone instants and old CLI's naive SQLite format accepted.
    naive = cli.show(inbox.path, case)["updated_at"]
    changed = post_status(inbox, case, "in_progress", naive)
    assert changed.status_code == 200
    after = changed.json()["item"]
    assert routes.timestamp(after["updated_at"]) > routes.timestamp(original["item"]["updated_at"])
    assert post_status(inbox, case, "in_progress", original["item"]["updated_at"]).status_code == 409
    external = cli.resolve(inbox.path, case, "withdrawn", expected_updated_at=after["updated_at"])
    assert post_status(inbox, case, "resolved", external["updated_at"]).json()["item"]["status"] == "resolved"
    with inbox.factory() as db:
        assert db.get(AuthUser, "learner-a") is not None  # No deletion side effects.


@pytest.mark.parametrize("override", [{"status": None}, {"status": "bad"}, {"expected_updated_at": None},
    {"expected_updated_at": "2026-10-25"}, {"expected_updated_at": "private-invalid"}, {"extra": "private-extra"}])
def test_status_strict_payload_and_sanitized_validation(inbox, override):
    case = seed(inbox)
    original = current(inbox, case)
    result = inbox.admin.post(BASE + "/" + case + "/status", json={"status": "resolved",
                              "expected_updated_at": original["item"]["updated_at"], **override})
    assert result.status_code == 422 and result.json() == {"error": {"code": "SUPPORT_ADMIN_INVALID_INPUT"}}
    assert current(inbox, case) == original


def test_reply_atomic_status_and_owner_can_see_but_other_account_cannot(inbox):
    case = seed(inbox, kind="deletion")
    result = post_reply(inbox, case, body(inbox, case, status="in_progress", message="  " + MESSAGE + "\n "))
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    value = result.json()
    assert value["item"]["status"] == "in_progress" and len(value["replies"]) == 1
    assert set(value["replies"][0]) == {"id", "message", "created_at"} and value["replies"][0]["message"] == MESSAGE
    assert str(UUID(value["replies"][0]["id"])) == value["replies"][0]["id"]
    public = inbox.client("learner-a").get("/api/v1/support/feedback/" + case)
    assert public.status_code == 200 and public.json()["replies"] == value["replies"]
    assert inbox.client("learner-b").get("/api/v1/support/feedback/" + case).status_code == 404
    with inbox.factory() as db: assert db.get(AuthUser, "learner-a") is not None


def test_replay_before_cas_preserves_later_status_and_never_adds_reply(inbox):
    case = seed(inbox)
    payload = body(inbox, case, status="in_progress")
    first = post_reply(inbox, case, payload).json()
    assert post_status(inbox, case, "resolved").status_code == 200
    replay = post_reply(inbox, case, payload)
    assert replay.status_code == 200 and replay.json()["replies"] == first["replies"]
    assert replay.json()["item"]["status"] == "resolved" and count_replies(inbox, case) == 1
    for change in ({"message": "另一条合成回复不能覆盖这条已经成功的回复。"}, {"status": "resolved"}):
        conflict = post_reply(inbox, case, {**payload, **change})
        assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "SUPPORT_REPLY_IDEMPOTENCY_CONFLICT"
    assert post_reply(inbox, case, {**payload, "request_id": str(uuid4())}).json()["error"]["code"] == "SUPPORT_CASE_CHANGED_REFRESH_REQUIRED"


@pytest.mark.parametrize("status", [None, "in_progress"])
def test_http_reply_digest_cli_replay_and_cli_reply_http_replay(inbox, status):
    case = seed(inbox)
    payload = body(inbox, case, **({"status": status} if status is not None else {}))
    first = post_reply(inbox, case, payload).json()
    receipt = cli._publish_reply(inbox.path, case, message=MESSAGE, request_id=payload["request_id"],
        expected_updated_at=payload["expected_updated_at"], status=status)
    assert receipt["reply_id"] == first["replies"][0]["id"] and count_replies(inbox, case) == 1
    next_payload = body(inbox, case, **({"status": status} if status is not None else {}))
    external = cli._publish_reply(inbox.path, case, message=MESSAGE, request_id=next_payload["request_id"],
        expected_updated_at=next_payload["expected_updated_at"], status=status)
    replay = post_reply(inbox, case, next_payload)
    assert replay.status_code == 200 and external["reply_id"] in {row["id"] for row in replay.json()["replies"]}
    assert count_replies(inbox, case) == 2


def test_optional_reply_status_retain_and_withdrawn_not_deleted(inbox):
    case = seed(inbox, status="withdrawn", kind="deletion")
    assert post_reply(inbox, case).json()["item"]["status"] == "withdrawn"
    with inbox.factory() as db: assert db.get(AuthUser, "learner-a") is not None


@pytest.mark.parametrize("override", [{"message": "short"}, {"message": "x" * 2001}, {"message": 123}, {"message": " " * 20},
    {"message": "控制字符不能被提交\x00这是合成内容"}, {"status": None}, {"status": "wrong"}, {"request_id": "not-a-uuid"},
    {"request_id": "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"}, {"expected_updated_at": "2026-10-25"},
    {"expected_updated_at": "2026-W43-7T10:00:00Z"}, {"expected_updated_at": "2026-10-25T10:00:00+99:00"},
    {"expected_updated_at": "0001-01-01T00:00:00+23:59"},
    {"expected_updated_at": "2026-10-25T10:00:00+01:99"},
    {"expected_updated_at": "2026-10-25T10:00:00-00:60"},
    {"expected_updated_at": 123}, {"user_id": "learner-b"}, {"email": "private@example.invalid"}])
def test_strict_body_extra_timestamp_validation_never_echoes(inbox, override):
    case = seed(inbox)
    result = post_reply(inbox, case, {**body(inbox, case), **override})
    assert result.status_code == 422 and result.json() == {"error": {"code": "SUPPORT_ADMIN_INVALID_INPUT"}}
    assert count_replies(inbox, case) == 0


@pytest.mark.parametrize("message", ["合成密钥 sk-" + "s" * 32, "验证码123456不要发送", "Bearer " + "s" * 20,
    "Cookie: synthetic-session", "a" * 43])
def test_sensitive_content_exact_safe_error_and_no_write(inbox, message):
    case = seed(inbox)
    result = post_reply(inbox, case, body(inbox, case, message=message))
    assert result.status_code == 422 and result.json() == {"error": {"code": "SUPPORT_REPLY_SENSITIVE_CONTENT"}}
    assert result.headers["cache-control"] == "no-store" and count_replies(inbox, case) == 0


def test_unencodable_surrogate_sanitized_and_no_write(inbox):
    case = seed(inbox)
    payload = body(inbox, case, message="这里有不可编码的合成文本\ud800不能提交")
    result = inbox.admin.post(BASE + "/" + case + "/reply", content=json.dumps(payload, ensure_ascii=True).encode("ascii"),
                              headers={"Content-Type": "application/json"})
    assert result.status_code == 422 and result.json() == {"error": {"code": "SUPPORT_ADMIN_INVALID_INPUT"}}
    assert count_replies(inbox, case) == 0


def test_real_sqlite_busy_no_partial_changes_then_same_key_retry(inbox, monkeypatch):
    case = seed(inbox)
    payload = body(inbox, case)
    original = routes.begin_write
    def brief_wait(db):
        db.execute(text("PRAGMA busy_timeout=1"))
        original(db)
    monkeypatch.setattr(routes, "begin_write", brief_wait)
    with sqlite3.connect(inbox.path) as held:
        held.execute("BEGIN IMMEDIATE")
        result = post_reply(inbox, case, payload)
        assert result.status_code == 503 and result.json()["error"]["code"] == "BETA_BUSY"
        assert result.headers["retry-after"] == "2" and result.headers["cache-control"] == "no-store"
        held.rollback()
    assert count_replies(inbox, case) == 0
    assert post_reply(inbox, case, payload).status_code == 200 and count_replies(inbox, case) == 1


def test_atomic_rollback_if_reply_insert_fails_after_status_update(inbox):
    case = seed(inbox)
    before = current(inbox, case)
    payload = body(inbox, case, status="resolved")
    with inbox.engine.begin() as conn:
        conn.execute(text("CREATE TRIGGER synthetic_reply_failure BEFORE INSERT ON support_replies BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END"))
    result = post_reply(inbox, case, payload)
    assert result.status_code == 503 and "synthetic-private-error" not in result.text
    assert current(inbox, case) == before and count_replies(inbox, case) == 0
    with inbox.engine.begin() as conn: conn.execute(text("DROP TRIGGER synthetic_reply_failure"))
    assert post_reply(inbox, case, payload).status_code == 200


def test_response_lost_after_commit_same_key_reconciles_one_reply(inbox, monkeypatch):
    case = seed(inbox)
    payload = body(inbox, case)
    original_commit = inbox.factory.class_.commit
    def committed_without_response(db):
        original_commit(db)
        raise ConnectionError("synthetic committed reply response was lost")
    with monkeypatch.context() as patch:
        patch.setattr(inbox.factory.class_, "commit", committed_without_response)
        with pytest.raises(ConnectionError, match="synthetic committed reply response was lost"):
            post_reply(inbox, case, payload)
    assert count_replies(inbox, case) == 1
    replay = post_reply(inbox, case, payload)
    assert replay.status_code == 200 and count_replies(inbox, case) == 1
    assert replay.json() == current(inbox, case)


def test_parallel_different_keys_have_one_cas_winner(inbox):
    case = seed(inbox)
    before = current(inbox, case)["item"]["updated_at"]
    payloads = [{"request_id": str(uuid4()), "message": MESSAGE, "expected_updated_at": before} for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda value: inbox.client().post(BASE + "/" + case + "/reply", json=value), payloads))
    assert [row.status_code for row in results].count(200) == 1
    assert [row.status_code for row in results].count(409) == 3
    assert all(row.json()["error"]["code"] == "SUPPORT_CASE_CHANGED_REFRESH_REQUIRED" for row in results if row.status_code == 409)
    assert count_replies(inbox, case) == 1


def test_parallel_identical_keys_return_same_single_reply(inbox):
    case = seed(inbox)
    payload = body(inbox, case)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: inbox.client().post(BASE + "/" + case + "/reply", json=payload), range(4)))
    assert all(row.status_code == 200 for row in results)
    assert len({row.json()["replies"][0]["id"] for row in results}) == 1 and count_replies(inbox, case) == 1


def test_parallel_status_updates_one_cas_winner(inbox):
    case = seed(inbox)
    before = current(inbox, case)["item"]["updated_at"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda status: inbox.client().post(BASE + "/" + case + "/status", json={"status": status,
                              "expected_updated_at": before}), ("resolved", "in_progress")))
    assert sorted(row.status_code for row in results) == [200, 409]


def test_reply_limit_twenty_includes_cli_and_replay_before_limit(inbox):
    case = seed(inbox)
    payload = body(inbox, case)
    first = post_reply(inbox, case, payload).json()
    for _ in range(19):
        cli._publish_reply(inbox.path, case, message=MESSAGE, request_id=str(uuid4()),
                           expected_updated_at=cli.show(inbox.path, case)["updated_at"])
    assert count_replies(inbox, case) == 20
    limited = post_reply(inbox, case)
    assert limited.status_code == 409 and limited.json()["error"]["code"] == "SUPPORT_REPLY_CASE_LIMIT"
    replay = post_reply(inbox, case, payload)
    assert replay.status_code == 200 and first["replies"][0] in replay.json()["replies"]
    assert len(replay.json()["replies"]) == 20


def test_offset_timestamp_equivalence_and_strict_microsecond_increment(inbox):
    case = seed(inbox, timestamp=datetime(2099, 1, 1, 0, 0, 0, 999998, timezone.utc))
    before = current(inbox, case)["item"]["updated_at"]
    local = routes.timestamp(before).astimezone(timezone(timedelta(hours=8))).isoformat()
    after = post_status(inbox, case, expected=local).json()["item"]["updated_at"]
    assert routes.timestamp(after) - routes.timestamp(before) == timedelta(microseconds=1)
    assert post_reply(inbox, case).status_code == 200


def test_storage_corruption_fails_closed_and_rolls_back(inbox):
    case = seed(inbox)
    with inbox.engine.begin() as conn:
        conn.execute(text("UPDATE support_feedback SET updated_at='private-invalid-value' WHERE id=:id"), {"id": case})
    for result in (inbox.admin.get(BASE), inbox.admin.get(BASE + "/" + case),
                   inbox.admin.post(BASE + "/" + case + "/status", json={"status": "resolved", "expected_updated_at": "2026-10-25T00:00:00Z"})):
        assert result.status_code == 503 and result.json() == {"error": {"code": "SUPPORT_ADMIN_DATA_INVALID"}}
        assert result.headers["cache-control"] == "no-store"
    assert count_replies(inbox, case) == 0


def test_corrupt_oversized_reply_thread_is_bounded_and_refuses_mutation(inbox):
    case = seed(inbox)
    payload = body(inbox, case, status="resolved")
    with inbox.engine.begin() as conn:
        for _ in range(21):
            conn.execute(text("""INSERT INTO support_replies(id,feedback_id,request_id,content_digest,message,created_at)
                                 VALUES(:id,:case,:key,:digest,:message,:created)"""),
                         {"id": str(uuid4()), "case": case, "key": str(uuid4()), "digest": "0" * 64,
                          "message": MESSAGE, "created": "2026-10-25T10:00:00.000000+00:00"})
    result = inbox.admin.get(BASE + "/" + case)
    assert result.status_code == 503 and result.json()["error"]["code"] == "SUPPORT_ADMIN_DATA_INVALID"
    assert post_reply(inbox, case, payload).json()["error"]["code"] == "SUPPORT_REPLY_CASE_LIMIT"
    with inbox.factory() as db:
        assert db.get(SupportFeedback, case).status == "received"
