"""Bound in-flight invitation API work before synchronous worker/DB pools saturate."""
from __future__ import annotations

import asyncio
from threading import Lock
from weakref import WeakKeyDictionary

from starlette.responses import JSONResponse

try:
    from backend.auth.settings import load_access_settings
except ModuleNotFoundError:
    from auth.settings import load_access_settings


class BetaConcurrencyLimit:
    def __init__(self, app, maximum: int = 12, queue_seconds: float = 10):
        self.app, self.maximum, self.queue_seconds = app, maximum, queue_seconds
        self._loops = WeakKeyDictionary()
        self._lock = Lock()

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if scope['type'] != 'http' or not path.startswith('/api/') or path == '/api/health':
            return await self.app(scope, receive, send)
        try:
            enabled = load_access_settings().mode == 'invite'
        except ValueError:
            enabled = False  # The inner configuration guard returns fail-closed 503.
        if not enabled:
            return await self.app(scope, receive, send)
        loop = asyncio.get_running_loop()
        with self._lock:
            limiter = self._loops.setdefault(loop, asyncio.Semaphore(self.maximum))
        try:
            await asyncio.wait_for(limiter.acquire(), timeout=self.queue_seconds)
        except TimeoutError:
            response = JSONResponse({'error': {'code': 'BETA_BUSY'}}, status_code=503,
                                    headers={'Retry-After': '2', 'Cache-Control': 'no-store'})
            return await response(scope, receive, send)
        try:
            # Hold until the complete response AND request-scoped DB teardown,
            # not merely until response headers leave a BaseHTTPMiddleware.
            await self.app(scope, receive, send)
        finally:
            limiter.release()
