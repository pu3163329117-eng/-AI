"""Server-side ownership boundary for the invitation-only beta.

Route policy is explicit: new learner endpoints fail closed until classified.
Unclaimed legacy profiles remain untouched and inaccessible in invite mode.
"""
from __future__ import annotations

import ipaddress
import os
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

try:
    from backend.auth.models import ProfileOwner
    from backend.support_admin_access import authorize_support
    from backend.auth.service import current_session, require_csrf
    from backend.auth.settings import load_access_settings
    from backend.db.assessment_models import AssessmentSession
    from backend.db.learning_path_models import RecommendationTask
    from backend.db.models import TrainingSession
    from backend.db.session import get_db
    from backend.domain.public_training import learner_training_response
except ModuleNotFoundError:
    from auth.models import ProfileOwner
    from support_admin_access import authorize_support
    from auth.service import current_session, require_csrf
    from auth.settings import load_access_settings
    from db.assessment_models import AssessmentSession
    from db.learning_path_models import RecommendationTask
    from db.models import TrainingSession
    from db.session import get_db
    from domain.public_training import learner_training_response


CONTENT_ROUTES = frozenset({
    ('GET', '/api/v1/lessons'),
    ('GET', '/api/v1/lessons/next'),
    ('GET', '/api/knowledge/coverage'),
    ('GET', '/api/v1/assessments/availability'),
    ('GET', '/api/v1/ai/status'),
})
ACCOUNT_ROUTES = frozenset({
    ('GET', '/api/v1/experience/tour'), ('POST', '/api/v1/experience/tour'),
    ('GET', '/api/v1/support/feedback'), ('POST', '/api/v1/support/feedback'),
    ('GET', '/api/v1/support/feedback/{feedback_id}'),
})
PROFILE_ROUTES = frozenset({
    ('GET', '/api/v1/profiles/{profile_id}'),
    ('GET', '/api/v1/profiles/{profile_id}/learning-summary'),
    ('GET', '/api/v1/profiles/{profile_id}/daily-mission'),
    ('GET', '/api/v1/profiles/{profile_id}/practice-plans'),
    ('GET', '/api/v1/profiles/{profile_id}/achievements'),
    ('GET', '/api/v1/profiles/{profile_id}/mistakes'),
    ('GET', '/api/v1/profiles/{profile_id}/sessions'),
    ('GET', '/api/v1/profiles/{profile_id}/assessments'),
    ('GET', '/api/v1/profiles/{profile_id}/ability'),
    ('GET', '/api/v1/profiles/{profile_id}/recommendations'),
    ('POST', '/api/v1/profiles/{profile_id}/recommendations'),
    ('POST', '/api/v1/profiles/{profile_id}/recommendations/{task_id}/start'),
    ('GET', '/api/v1/profiles/{profile_id}/observations/report'),
})
TRAINING_ROUTES = frozenset({
    ('GET', '/api/v1/training/sessions/{session_id}'),
    ('POST', '/api/v1/training/sessions/{session_id}/commands'),
    ('GET', '/api/v1/training/sessions/{session_id}/reasoning'),
})
ASSESSMENT_ROUTES = frozenset({
    ('GET', '/api/v1/assessments/{assessment_id}'),
    ('POST', '/api/v1/assessments/{assessment_id}/commands'),
})
CREATION_ROUTES = frozenset({('POST', '/api/v1/profiles'), ('POST', '/api/v1/training/sessions'), ('POST', '/api/v1/assessments')})
AUTH_ROUTES = frozenset({
    ('GET', '/api/v1/auth/session'), ('POST', '/api/v1/auth/login'),
    ('POST', '/api/v1/auth/redeem'), ('POST', '/api/v1/auth/logout'),
    ('POST', '/api/v1/auth/email/request'), ('POST', '/api/v1/auth/email/verify'),
})


def deny(code: str, status: int = 403):
    raise HTTPException(status, detail={'code': code})


def student_response(payload: dict) -> dict:
    # Local teaching tools keep their legacy contract; the invitation beta is
    # deliberately narrower, including reads of receipts written before upgrade.
    return learner_training_response(payload) if load_access_settings().mode == 'invite' else payload


def local_peer(request: Request) -> bool:
    peer = request.client.host if request.client else ''
    # Starlette's in-process TestClient has no TCP peer. This cannot be set by HTTP headers.
    if peer == 'testclient':
        return True
    try:
        return ipaddress.ip_address(peer).is_loopback
    except ValueError:
        return False


def require_production_storage(settings) -> None:
    if not settings.production:
        return
    # A production launch must not silently pick up the local developer's DB or
    # a serverless /tmp file. PostgreSQL migration is not implemented by this beta.
    try:
        from backend.scripts.beta_preflight import _sqlite_path
    except ModuleNotFoundError:
        from scripts.beta_preflight import _sqlite_path
    if os.getenv('VERCEL'):
        raise ValueError('BETA_REQUIRES_PERSISTENT_SERVER_STORAGE')
    _sqlite_path(dict(os.environ))


def require_owner(db: Session, user_id: str, profile_id: str | None) -> None:
    owner = db.get(ProfileOwner, profile_id) if isinstance(profile_id, str) and profile_id else None
    if owner is None or owner.user_id != user_id:
        # Do not distinguish unknown IDs from another learner's existing record.
        deny('RESOURCE_NOT_FOUND', 404)


def require_training_owner(db: Session, user_id: str, session_id: str | None) -> None:
    record = db.get(TrainingSession, session_id) if isinstance(session_id, str) and session_id else None
    if record is None:
        deny('RESOURCE_NOT_FOUND', 404)
    require_owner(db, user_id, record.profile_id)


async def authorize_request(request: Request, db: Annotated[Session, Depends(get_db)]) -> None:
    route = getattr(request.scope.get('route'), 'path', request.url.path)
    policy = (request.method, route)
    body = None
    if policy in CREATION_ROUTES and route != '/api/v1/profiles':
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            deny('INVALID_REQUEST', 422)
        if not isinstance(body, dict):
            deny('INVALID_REQUEST', 422)
    # SQLAlchemy uses synchronous connections. Never acquire a pooled connection
    # on the event loop: saturation would block the same loop needed to complete
    # other requests and release their sessions. Body I/O remains asynchronous.
    await run_in_threadpool(_authorize_and_release, request, db, route, policy, body)


def _authorize_and_release(request: Request, db: Session, route: str, policy: tuple[str, str], body: dict | None) -> None:
    try:
        _authorize_sync(request, db, route, policy, body)
    finally:
        # This layer is read-only. End its read transaction before scheduling
        # handlers; otherwise queued guards can occupy every pool connection and
        # worker while the handlers that would release them are still waiting.
        # No learning command, receipt or account mutation has begun here.
        if db is not None:
            db.rollback()


def _authorize_sync(request: Request, db: Session, route: str, policy: tuple[str, str], body: dict | None) -> None:
    try:
        settings = load_access_settings()
    except ValueError:
        deny('ACCESS_CONFIGURATION_INVALID', 503)
    if route == '/api/health' or policy in AUTH_ROUTES:
        return
    if settings.mode == 'local':
        if route.startswith('/api/v1/admin/') and not settings.admin_enabled:
            deny('ADMIN_DISABLED', 404)
        if not local_peer(request):
            deny('LOCAL_DEVELOPMENT_ONLY')
        return

    # Keep local toolchains and paid preview outside the public beta even for admins.
    if route.startswith('/api/v1/collaboration') or route.startswith('/api/v1/ai/sessions/') or route.startswith('/api/v1/admin/ai-reason-review'):
        deny('BETA_FEATURE_DISABLED', 404)
    identity = current_session(request, db, settings)
    if identity is None:
        deny('AUTH_REQUIRED', 401)
    user, auth_session = identity
    request.state.auth_user_id = user.id
    request.state.auth_role = user.role
    if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
        require_csrf(request, auth_session, settings)

    if route.startswith('/api/v1/admin/support/'):
        authorize_support(request, settings=settings, user=user)
        return

    if route.startswith('/api/v1/admin/'):
        if not settings.admin_enabled:
            deny('ADMIN_DISABLED', 404)
        if user.role != 'admin':
            deny('ADMIN_REQUIRED')
        return
    if policy in PROFILE_ROUTES:
        require_owner(db, user.id, request.path_params.get('profile_id'))
        if 'task_id' in request.path_params:
            task = db.get(RecommendationTask, request.path_params['task_id'])
            if task is None or task.profile_id != request.path_params['profile_id']:
                deny('RESOURCE_NOT_FOUND', 404)
        return
    if policy in TRAINING_ROUTES:
        require_training_owner(db, user.id, request.path_params.get('session_id'))
        return
    if policy in ASSESSMENT_ROUTES:
        assessment = db.get(AssessmentSession, request.path_params.get('assessment_id'))
        if assessment is None:
            deny('RESOURCE_NOT_FOUND', 404)
        require_owner(db, user.id, assessment.profile_id)
        return
    if policy == ('GET', '/api/knowledge/lookup'):
        require_training_owner(db, user.id, request.query_params.get('session_id'))
        return
    if policy in ACCOUNT_ROUTES:
        return
    if policy in CONTENT_ROUTES:
        if policy == ('GET', '/api/v1/lessons/next') and 'profile_id' in request.query_params:
            require_owner(db, user.id, request.query_params.get('profile_id'))
        return
    if policy in CREATION_ROUTES:
        if route != '/api/v1/profiles':
            require_owner(db, user.id, body.get('profile_id'))
        return
    deny('ACCESS_POLICY_REQUIRED')


async def security_headers(request: Request, call_next):
    """No private API cache; close API docs and reject unrelated beta Host values."""
    try:
        settings = load_access_settings()
    except ValueError:
        from fastapi.responses import JSONResponse
        return JSONResponse({'error': {'code': 'ACCESS_CONFIGURATION_INVALID'}}, status_code=503, headers={'Cache-Control': 'no-store'})
    if settings.production:
        try:
            # Some ASGI hosts do not run lifespan. Check before routing or a DB
            # dependency can connect, including for the health endpoint.
            await run_in_threadpool(require_production_storage, settings)
        except (ValueError, OSError):
            from fastapi.responses import JSONResponse
            return JSONResponse({'error': {'code': 'ACCESS_CONFIGURATION_INVALID'}}, status_code=503, headers={'Cache-Control': 'no-store'})
    if settings.mode == 'local':
        from fastapi.responses import JSONResponse
        if request.url.path.startswith('/api/v1/admin/') and not settings.admin_enabled:
            return JSONResponse({'error': {'code': 'ADMIN_DISABLED'}}, status_code=404, headers={'Cache-Control': 'no-store'})
        if request.url.path.startswith(('/api/v1/admin/ai-reason-review', '/api/v1/ai/sessions/')):
            # This guard intentionally precedes dependency resolution/database
            # access, preserving the older paid-preview/export perimeter.
            try:
                try:
                    from backend.ai_routes import local_preview_only
                except ModuleNotFoundError:
                    from ai_routes import local_preview_only
                local_preview_only(request)
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {'code': str(exc.detail)}
                return JSONResponse({'error': detail}, status_code=exc.status_code, headers={'Cache-Control': 'no-store'})
        if request.url.path.startswith('/api/') and request.url.path != '/api/health' and not local_peer(request):
            return JSONResponse({'error': {'code': 'LOCAL_DEVELOPMENT_ONLY'}}, status_code=403, headers={'Cache-Control': 'no-store'})
    if settings.mode == 'invite':
        from fastapi.responses import JSONResponse
        if request.url.path in {'/openapi.json', '/redoc'} or request.url.path.startswith('/docs'):
            return JSONResponse({'error': {'code': 'NOT_FOUND'}}, status_code=404, headers={'Cache-Control': 'no-store'})
        hosts = {urlsplit(origin).netloc.lower() for origin in settings.allowed_origins}
        if request.url.netloc.lower() not in hosts and request.url.path != '/api/health':
            return JSONResponse({'error': {'code': 'HOST_NOT_ALLOWED'}}, status_code=400, headers={'Cache-Control': 'no-store'})
    response = await call_next(request)
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Pragma'] = 'no-cache'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
    return response
