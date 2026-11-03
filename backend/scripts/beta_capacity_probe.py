"""Opt-in local synthetic workload; never targets an operator's learning database.

Run: python -m backend.scripts.beta_capacity_probe --confirm-synthetic-only
Creates a NEW ignored output directory, pre-seeds synthetic sessions, starts its
own loopback server, and stops that child. No email or model calls are made.
This is not a cloud capacity certificate or an OTP/email deliverability test.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import http.client
import json
import math
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from uuid import uuid4


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(len(ordered) * percent) - 1)], 2) if ordered else 0.0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--confirm-synthetic-only', action='store_true', required=True)
    parser.add_argument('--users', type=int, default=100)
    parser.add_argument('--concurrency', type=int, default=10)
    args = parser.parse_args(argv)
    if not 2 <= args.users <= 100 or not 1 <= args.concurrency <= args.users:
        parser.error('Use 2..100 synthetic accounts and concurrency between 1 and users')
    project = Path(__file__).resolve().parents[2]
    root = project / 'output' / 'beta-capacity'
    root.mkdir(parents=True, exist_ok=True)
    # Never accept a source database, arbitrary URL, database path or live cookie.
    folder = Path(tempfile.mkdtemp(prefix='synthetic-', dir=root)).resolve()
    if not folder.is_relative_to(root.resolve()):
        raise RuntimeError('SYNTHETIC_PATH_INVALID')
    database = folder / 'synthetic.db'
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0))
        port = port_probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    for name in ('DEEPSEEK_API_KEY', 'RESEND_API_KEY', 'VERCEL'):
        os.environ.pop(name, None)
    os.environ.update({
        'WENYAN_ENV': 'test', 'WENYAN_ACCESS_MODE': 'invite',
        'WENYAN_AUTH_LOGIN_METHOD': 'password', 'WENYAN_AUTH_COOKIE_SECURE': '0',
        'WENYAN_AUTH_ORIGINS': origin, 'WENYAN_ADMIN_ENABLED': '0',
        'WENYAN_AI_ENABLED': '0', 'WENYAN_COLLABORATION_ENABLED': '0',
        'WENYAN_COLLABORATION_REAL_CALLS_ENABLED': '0',
        'WENYAN_DATABASE_URL': 'sqlite:///' + database.as_posix(),
    })
    # Imports deliberately occur only after fixing the isolated DB configuration.
    from sqlalchemy import select
    from backend.auth.models import AuthSession, AuthUser, ProfileOwner, utcnow
    from backend.auth.service import COOKIE_NAME, token_hash
    from backend.db.init import init_db
    from backend.db.models import LearnerProfile, Lesson
    from backend.db.session import SessionLocal, engine
    init_db()
    accounts = []
    with SessionLocal() as db:
        lesson_id = db.scalar(select(Lesson.id).where(Lesson.status == 'PUBLISHED', Lesson.school_stage == 'SENIOR'))
        if not lesson_id:
            raise RuntimeError('SYNTHETIC_LESSON_MISSING')
        for index in range(args.users):
            user_id, profile_id = str(uuid4()), str(uuid4())
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            db.add(AuthUser(id=user_id, username=f'load-{index}-{uuid4().hex[:8]}',
                            password_hash='synthetic-disabled-password', role='learner'))
            db.add(LearnerProfile(id=profile_id, display_name=f'合成用户{index}', school_stage='SENIOR'))
            db.flush()
            db.add(ProfileOwner(profile_id=profile_id, user_id=user_id))
            db.add(AuthSession(user_id=user_id, token_hash=token_hash(token), csrf_token=csrf,
                               expires_at=utcnow() + timedelta(hours=1)))
            accounts.append((profile_id, token, csrf))
        db.commit()
    engine.dispose()

    def workload(item):
        index, (profile_id, token, csrf) = item
        samples = []
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        headers = {'Origin': origin, 'Cookie': COOKIE_NAME + '=' + token,
                   'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
                   'X-Wenyan-Training-Contract': 'guided-v1'}

        def call(label, method, path, expected=200, body=None, extra=None):
            started = time.perf_counter()
            try:
                connection.request(method, path, body=json.dumps(body) if body is not None else None,
                                   headers={**headers, **(extra or {})})
                response = connection.getresponse()
                payload = response.read()
                ok = response.status == expected and response.getheader('Cache-Control') == 'no-store'
                samples.append({'operation': label, 'ok': ok, 'status': response.status,
                                'milliseconds': (time.perf_counter() - started) * 1000})
                return json.loads(payload) if ok else None
            except (OSError, ValueError, http.client.HTTPException):
                samples.append({'operation': label, 'ok': False, 'status': 0,
                                'milliseconds': (time.perf_counter() - started) * 1000})
                return None
        try:
            call('session', 'GET', '/api/v1/auth/session')
            call('profile', 'GET', '/api/v1/profiles/' + profile_id)
            call('summary', 'GET', '/api/v1/profiles/' + profile_id + '/learning-summary')
            foreign_id = accounts[(index + 1) % args.users][0]
            call('cross_user_denied', 'GET', '/api/v1/profiles/' + foreign_id, expected=404)
            created = call('training_create', 'POST', '/api/v1/training/sessions', expected=201,
                           body={'profile_id': profile_id, 'lesson_id': lesson_id})
            if created:
                session_id = created['session_id']
                call('training_read', 'GET', '/api/v1/training/sessions/' + session_id)
                command = {'type': 'DEFER_VARIABLE', 'expected_state_version': created['session']['state_version'], 'payload': {}}
                call('training_write', 'POST', '/api/v1/training/sessions/' + session_id + '/commands',
                     body=command, extra={'Idempotency-Key': 'synthetic-' + str(uuid4())})
            return samples
        finally:
            connection.close()

    log_path = folder / 'server.log'
    with log_path.open('xb') as server_log:
        server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.main:app',
                                   '--host', '127.0.0.1', '--port', str(port), '--no-proxy-headers',
                                   '--no-access-log'], cwd=project, env=dict(os.environ),
                                  stdout=server_log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 60
            while True:
                if server.poll() is not None:
                    raise RuntimeError('SYNTHETIC_SERVER_START_FAILED')
                try:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                    connection.request('GET', '/api/health')
                    ready = connection.getresponse().status == 200
                    connection.close()
                    if ready:
                        break
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('SYNTHETIC_SERVER_START_TIMEOUT')
                time.sleep(.1)
            started = time.perf_counter()
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                samples = [sample for group in pool.map(workload, enumerate(accounts)) for sample in group]
            elapsed = time.perf_counter() - started
        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
    timings = [sample['milliseconds'] for sample in samples]
    failures = [sample for sample in samples if not sample['ok']]
    report = {
        'scope': 'local_synthetic_not_cloud_capacity_or_email_test',
        'authentication': 'preseeded_synthetic_sessions_no_email_or_password_login_load',
        'accounts': args.users, 'worker_concurrency': args.concurrency,
        'requests': len(samples), 'expected_requests': args.users * 7,
        'failures': len(failures), 'duration_seconds': round(elapsed, 2),
        'p50_ms': percentile(timings, .5), 'p95_ms': percentile(timings, .95),
        'p99_ms': percentile(timings, .99),
        'operations': {name: {'requests': sum(s['operation'] == name for s in samples),
                              'failures': sum(s['operation'] == name and not s['ok'] for s in samples)}
                       for name in sorted({s['operation'] for s in samples})},
        'failure_statuses': sorted({s['status'] for s in failures}),
        'cloud_release_approved': False,
    }
    report_path = folder / 'report.json'
    with report_path.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
    print(json.dumps({**report, 'report': str(report_path)}, ensure_ascii=False))
    return 0 if not failures and len(samples) == args.users * 7 else 1


if __name__ == '__main__':
    raise SystemExit(main())
