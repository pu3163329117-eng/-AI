"""Child process: run only the synthetic capacity probe against its own loopback server."""
import contextlib
import http.client
import importlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(sys.argv[1]).resolve()
WORK = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(ROOT))
sys.path.insert(1, os.environ['WENYAN_TEST_SITE_DIR'])
assert not (ROOT / 'backend' / '.env').exists()
probe = importlib.import_module('backend.scripts.beta_capacity_probe')
# Keep the synthetic DB, logs and report inside pytest's temporary directory.
probe.__file__ = str(WORK / 'backend' / 'scripts' / 'beta_capacity_probe.py')
os.environ['PYTHONPATH'] = str(ROOT) + os.pathsep + os.environ['WENYAN_TEST_SITE_DIR']
request_original = http.client.HTTPConnection.request
close_original = http.client.HTTPConnection.close
seen_create = []
seen_write = []
readbacks = []

def request(self, method, url, body=None, headers=None, *args, **kwargs):
    assert self.host == '127.0.0.1'
    if method == 'POST' and url == '/api/v1/training/sessions':
        seen_create.append((headers or {}).get('X-Wenyan-Training-Contract') == 'guided-v1')
    if method == 'POST' and url.endswith('/commands'):
        seen_write.append((headers or {}).get('X-Wenyan-Training-Contract') == 'guided-v1')
        self._synthetic_readback = (url.removesuffix('/commands'), dict(headers or {}))
    return request_original(self, method, url, body=body, headers=headers or {}, *args, **kwargs)

def close(self):
    check = getattr(self, '_synthetic_readback', None)
    if check:
        self._synthetic_readback = None
        path, headers = check
        request_original(self, 'GET', path, headers=headers)
        response = self.getresponse()
        data = json.loads(response.read())
        readbacks.append(response.status == 200 and response.getheader('Cache-Control') == 'no-store'
                         and data['session']['state_version'] >= 2)
    return close_original(self)

http.client.HTTPConnection.request = request
http.client.HTTPConnection.close = close
out = io.StringIO()
with contextlib.redirect_stdout(out):
    code = probe.main(['--confirm-synthetic-only', '--users', '2', '--concurrency', '1'])
report = json.loads(out.getvalue())
assert code == 0 and report['requests'] == report['expected_requests'] == 14 and report['failures'] == 0
assert seen_create == [True, True] and seen_write == [True, True] and readbacks == [True, True]
for op in ('training_create', 'training_read', 'training_write', 'cross_user_denied'):
    assert report['operations'][op] == {'requests': 2, 'failures': 0}
folder = Path(report['report']).resolve().parent
assert folder.is_relative_to((WORK / 'output' / 'beta-capacity').resolve())
database = folder / 'synthetic.db'
with sqlite3.connect(database) as db:
    assert db.execute('SELECT COUNT(*) FROM training_sessions').fetchone()[0] == 2
    assert db.execute('SELECT MIN(state_version) FROM training_sessions').fetchone()[0] >= 2
    assert db.execute('SELECT COUNT(*) FROM command_receipts').fetchone()[0] == 2
    assert db.execute('SELECT COUNT(*) FROM training_events').fetchone()[0] >= 2
print('synthetic capacity: create/header, write/header and post-write readback passed for 2 accounts')
