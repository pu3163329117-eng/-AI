import importlib,os,sys,types
from pathlib import Path
ROOT=Path(sys.argv[2]).resolve()
WORK=Path(sys.argv[3]).resolve()
mode=sys.argv[1]
sys.path.insert(0,str(ROOT if mode=='package' else ROOT/'backend'))
sys.path.insert(1,os.environ['WENYAN_TEST_SITE_DIR'])
if mode=='package':
 main=importlib.import_module('backend.main'); access=importlib.import_module('backend.access'); preflight=importlib.import_module('backend.scripts.beta_preflight'); control=importlib.import_module('backend.collaboration.controller'); db=importlib.import_module('backend.db.session')
else:
 assert not any(Path(x).resolve()==ROOT for x in sys.path if x)
 main=importlib.import_module('main');access=importlib.import_module('access');preflight=importlib.import_module('scripts.beta_preflight');control=importlib.import_module('collaboration.controller');db=importlib.import_module('db.session')
from fastapi.testclient import TestClient
assert not (ROOT/'backend'/'.env').exists()
os.environ.update({'WENYAN_ENV':'production','WENYAN_ACCESS_MODE':'invite','WENYAN_AUTH_ORIGINS':'https://testserver','WENYAN_AUTH_COOKIE_SECURE':'true','WENYAN_AUTH_LOGIN_METHOD':'password'})
persistent=WORK/'persistent'/'synthetic-persistent.sqlite'
os.environ['WENYAN_DATABASE_URL']='sqlite:///'+persistent.as_posix()
assert TestClient(main.app).get('/api/health').status_code==200
os.environ['VERCEL']='synthetic-nonempty'
actual=TestClient(main.app).get('/api/health')
assert actual.status_code==503 and actual.headers['cache-control']=='no-store'
os.environ.pop('VERCEL',None)
settings=types.SimpleNamespace(production=True,mode='invite',admin_enabled=False,allowed_origins=('https://testserver',))
main.load_access_settings=lambda:settings;access.load_access_settings=lambda:settings
main.init_db=lambda:None;control.startup=lambda:None;control.shutdown=lambda:None
persistent=WORK/'persistent'/'synthetic-persistent.sqlite'; temporary=WORK/'transient'/'synthetic-temp.sqlite'
def seturl(p):os.environ['WENYAN_DATABASE_URL']='sqlite:///'+p.as_posix()
def check_reject():
 called=[]
 def forbidden_db():
  called.append(True)
  raise AssertionError('storage rejection must precede database access')
 main.app.dependency_overrides[db.get_db]=forbidden_db
 for path in ('/api/health','/api/v1/lessons'):
  response=TestClient(main.app).get(path)
  assert response.status_code==503 and response.json()=={'error':{'code':'ACCESS_CONFIGURATION_INVALID'}}
  assert response.headers['cache-control']=='no-store' and 'synthetic-' not in response.text
 main.app.dependency_overrides.pop(db.get_db)
 assert not called
 assert not persistent.exists() and not temporary.exists()
os.environ.pop('VERCEL',None);seturl(persistent)
assert TestClient(main.app).get('/api/health').status_code==200
with TestClient(main.app) as c:assert c.get('/api/health').status_code==200
os.environ['WENYAN_DATABASE_URL']='sqlite:///:memory:';check_reject()
try:
 with TestClient(main.app):raise AssertionError('invalid storage started')
except ValueError:pass
seturl(temporary);check_reject()
seturl(persistent);os.environ['VERCEL']='synthetic-nonempty';check_reject()
os.environ.pop('VERCEL',None);settings.production=False;settings.mode='local';os.environ['WENYAN_DATABASE_URL']='sqlite:///:memory:'
assert TestClient(main.app).get('/api/health').status_code==200
# Verify preflight selects the AI module corresponding to the active package,
# while using a fake loader and an explicit synthetic configuration mapping.
module_name='backend.ai.settings' if mode=='package' else 'ai.settings'
fake=types.ModuleType(module_name);fake.load_settings=lambda **kw:types.SimpleNamespace(enabled=False)
sys.modules[module_name]=fake
checks=preflight.run_preflight({'WENYAN_DATABASE_URL':'sqlite:///'+persistent.as_posix()},check_storage=False)['checks']
assert next(c for c in checks if c['check']=='effective_ai_disabled')['passed'] is True
print(mode,'8 synthetic boundary probes plus real-settings checks passed')
sys.exit(0)
