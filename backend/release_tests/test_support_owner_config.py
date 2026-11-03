from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import backend.access as access
import backend.auth.routes as auth_routes
import backend.auth.email_service as email_service
import backend.support_admin_access as support_access
import backend.support_admin_routes as support_routes
from backend.auth.models import AuthSession, AuthUser, utcnow
from backend.auth.service import COOKIE_NAME, token_hash
from backend.db.session import Base, get_db
from backend.main import app

OWNER='owner@demo.test'
OTHER='other@demo.test'

@pytest.fixture
def boundary(monkeypatch):
    engine=create_engine('sqlite:///:memory:',connect_args={'check_same_thread':False},poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory=sessionmaker(bind=engine,expire_on_commit=False,autoflush=False)
    settings=SimpleNamespace(mode='invite',admin_enabled=False,allowed_origins=('http://testserver',),production=False,cookie_secure=False,login_method='email_code')
    users={'owner':('a'*43,'admin',OWNER), 'other':('b'*43,'admin',OTHER), 'learner':('c'*43,'learner','learner@demo.test')}
    with factory() as db:
        for name,(token,role,email) in users.items():
            db.add(AuthUser(id=name,username='synthetic-'+name,email=email,password_hash='unused',role=role))
            db.add(AuthSession(id=str(uuid4()),user_id=name,token_hash=token_hash(token),csrf_token='csrf-'+name,expires_at=utcnow()+timedelta(hours=1)))
        db.commit()
    for module in (access,auth_routes,support_access,support_routes): monkeypatch.setattr(module,'load_access_settings',lambda:settings)
    monkeypatch.setenv('WENYAN_SUPPORT_ADMIN_ENABLED','1')
    monkeypatch.setenv('WENYAN_SUPPORT_OWNER_EMAIL',OWNER)
    def override():
        with factory() as db: yield db
    previous=app.dependency_overrides.get(get_db); app.dependency_overrides[get_db]=override
    def client(name=None):
        headers={'Origin':'http://testserver'}
        if name: headers['X-CSRF-Token']='csrf-'+name
        c=TestClient(app,headers=headers,follow_redirects=False)
        if name: c.cookies.set(COOKIE_NAME,users[name][0])
        return c
    yield SimpleNamespace(client=client,settings=settings,factory=factory)
    if previous is None: app.dependency_overrides.pop(get_db,None)
    else: app.dependency_overrides[get_db]=previous
    engine.dispose()

def test_roles_csrf_and_current_owner(boundary):
    path=support_routes.PREFIX
    assert boundary.client().get(path).status_code==401
    assert boundary.client('owner').get(path).status_code==200
    assert boundary.client('other').get(path).status_code==403
    assert boundary.client('learner').get(path).status_code==403
    assert boundary.client('owner').get('/api/v1/auth/session').json()['support_admin_enabled'] is True
    assert boundary.client('other').get('/api/v1/auth/session').json()['support_admin_enabled'] is False
    post=path+'/00000000-0000-0000-0000-000000000001/status'
    assert boundary.client('owner').post(post,json={},headers={'X-CSRF-Token':''}).status_code==403
    assert boundary.client('owner').post(post,json={},headers={'Origin':'http://attacker.invalid'}).status_code==403

@pytest.mark.parametrize('bad',[None,'','bad','a@b','a@b.test,other@b.test','a@b.test\nother@b.test'])
def test_missing_or_invalid_owner_fail_closed(boundary,monkeypatch,bad):
    if bad is None: monkeypatch.delenv('WENYAN_SUPPORT_OWNER_EMAIL',raising=False)
    else: monkeypatch.setenv('WENYAN_SUPPORT_OWNER_EMAIL',bad)
    response=boundary.client('owner').get(support_routes.PREFIX)
    assert response.status_code==503
    assert response.json()=={'error':{'code':'ACCESS_CONFIGURATION_INVALID'}}
    assert response.headers.get('cache-control')=='no-store'
    assert 'WENYAN_SUPPORT_OWNER_EMAIL' not in response.text
    for actor in (None,'owner','other','learner'):
        session=boundary.client(actor).get('/api/v1/auth/session')
        assert session.status_code==200
        assert session.json()['support_admin_enabled'] is False
    monkeypatch.setenv('WENYAN_SUPPORT_ADMIN_ENABLED','0')
    response=boundary.client('owner').get('/api/v1/auth/session')
    assert response.status_code==200 and response.json()['support_admin_enabled'] is False
    assert boundary.client('owner').get(support_routes.PREFIX).status_code==404

@pytest.mark.parametrize('bad',[None,'not-an-address'])
def test_mock_email_login_survives_support_config_and_recovers(boundary,monkeypatch,bad):
    if bad is None: monkeypatch.delenv('WENYAN_SUPPORT_OWNER_EMAIL',raising=False)
    else: monkeypatch.setenv('WENYAN_SUPPORT_OWNER_EMAIL',bad)
    monkeypatch.setenv('WENYAN_AUTH_EMAIL_PROVIDER','mock')
    monkeypatch.setenv('WENYAN_AUTH_OTP_SECRET','synthetic-test-only-'*3)
    captured={}
    monkeypatch.setattr(email_service,'send_code',lambda config,request,email,code,challenge_id: captured.update(code=code))
    client=boundary.client()
    request=client.post('/api/v1/auth/email/request',json={'email':OWNER,'purpose':'login'})
    assert request.status_code==200 and 'code' in captured
    verification=client.post('/api/v1/auth/email/verify',json={'email':OWNER,'challenge_id':request.json()['challenge_id'],'code':captured['code']})
    assert verification.status_code==200
    assert verification.json()['authenticated'] is True
    assert verification.json()['support_admin_enabled'] is False
    assert client.get('/api/v1/auth/session').json()['support_admin_enabled'] is False
    assert client.get(support_routes.PREFIX).status_code==503
    monkeypatch.setenv('WENYAN_SUPPORT_OWNER_EMAIL',OWNER)
    assert client.get('/api/v1/auth/session').json()['support_admin_enabled'] is True
    assert client.get(support_routes.PREFIX).status_code==200

def test_invalid_support_switch_does_not_break_session(boundary,monkeypatch):
    monkeypatch.setenv('WENYAN_SUPPORT_ADMIN_ENABLED','invalid')
    for actor in (None,'owner','learner'):
        response=boundary.client(actor).get('/api/v1/auth/session')
        assert response.status_code==200 and response.json()['support_admin_enabled'] is False
    assert boundary.client('owner').get(support_routes.PREFIX).status_code==503

def test_changes_rechecked_each_request_and_disabled_user(boundary,monkeypatch):
    path=support_routes.PREFIX
    owner=boundary.client('owner'); other=boundary.client('other')
    assert owner.get(path).status_code==200
    monkeypatch.setenv('WENYAN_SUPPORT_OWNER_EMAIL','OTHER@DEMO.TEST')
    assert owner.get(path).status_code==403
    assert other.get(path).status_code==200
    monkeypatch.setenv('WENYAN_SUPPORT_ADMIN_ENABLED','0')
    assert other.get(path).status_code==404
    monkeypatch.setenv('WENYAN_SUPPORT_ADMIN_ENABLED','1')
    with boundary.factory() as db:
        person=db.get(AuthUser,'other'); person.disabled=True; db.commit()
    assert other.get(path).status_code in {401,403}

@pytest.mark.parametrize(('method','suffix'),[
    ('get',''),
    ('get','/00000000-0000-0000-0000-000000000001'),
    ('post','/00000000-0000-0000-0000-000000000001/status'),
    ('post','/00000000-0000-0000-0000-000000000001/reply'),
])
def test_all_support_actions_require_exact_owner(boundary,method,suffix):
    boundary.settings.admin_enabled=True
    for actor,status in ((None,401),('learner',403),('other',403)):
        request=getattr(boundary.client(actor),method)
        response=request(support_routes.PREFIX+suffix,**({'json':{}} if method=='post' else {}))
        assert response.status_code==status

def test_role_change_is_rechecked(boundary):
    owner=boundary.client('owner')
    assert owner.get(support_routes.PREFIX).status_code==200
    with boundary.factory() as db:
        person=db.get(AuthUser,'owner'); person.role='learner'; db.commit()
    assert owner.get(support_routes.PREFIX).status_code==403
