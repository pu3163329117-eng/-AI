from __future__ import annotations

import hmac
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from .contracts import CreateManifestRequest, CreateRunRequest, CreateTaskRequest, FollowUpRequest
from .controller import controller
from .service import BridgeError, CollaborationService


router = APIRouter(prefix="/api/v1/collaboration", tags=["collaboration"])


def _error(exc: BridgeError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail={"code": exc.code, **exc.details})


def require_collaboration_access(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    origin: Annotated[str | None, Header()] = None,
) -> None:
    settings = controller.settings
    if not settings or not settings.enabled:
        raise HTTPException(status_code=503, detail={"code": "COLLABORATION_BRIDGE_DISABLED"})
    loopback_hosts = {"127.0.0.1", "localhost", "::1", "testserver", "testclient"}
    client_host = request.client.host if request.client else None
    if request.url.hostname not in loopback_hosts or client_host not in loopback_hosts:
        raise HTTPException(status_code=403, detail={"code": "COLLABORATION_LOOPBACK_ONLY"})
    if origin and origin not in settings.allowed_origins:
        raise HTTPException(status_code=403, detail={"code": "COLLABORATION_ORIGIN_DENIED"})
    expected = f"Bearer {settings.token}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail={"code": "COLLABORATION_TOKEN_REQUIRED"}, headers={"WWW-Authenticate": "Bearer"})


def get_service(_: Annotated[None, Depends(require_collaboration_access)]) -> CollaborationService:
    if not controller.service:
        raise HTTPException(status_code=503, detail={"code": "COLLABORATION_BRIDGE_UNAVAILABLE"})
    return controller.service


Service = Annotated[CollaborationService, Depends(get_service)]


@router.post("/tasks", status_code=201)
def create_task(request: CreateTaskRequest, service: Service):
    try:
        return service.create_task(request)
    except BridgeError as exc:
        raise _error(exc) from None


@router.post("/tasks/{task_id}/runs", status_code=201)
def create_run(task_id: str, request: CreateRunRequest, service: Service, response: Response,
               key: Annotated[str | None, Header(alias="Idempotency-Key")] = None):
    try:
        payload, created = service.create_run(task_id, request, key or "")
        response.status_code = 201 if created else 200
        return payload
    except BridgeError as exc:
        raise _error(exc) from None


@router.post("/tasks/{task_id}/context-manifests", status_code=201)
def create_context_manifest(
    task_id: str, request: CreateManifestRequest, service: Service, response: Response,
    key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
):
    try:
        payload, created = service.create_manifest(task_id, request, key or "")
        response.status_code = 201 if created else 200
        return payload
    except BridgeError as exc:
        raise _error(exc) from None


@router.post("/tasks/{task_id}/messages", status_code=202)
def append_message(task_id: str, request: FollowUpRequest, service: Service, response: Response,
                   key: Annotated[str | None, Header(alias="Idempotency-Key")] = None):
    try:
        payload, created = service.append_message(task_id, request, key or "")
        response.status_code = 202 if created else 200
        return payload
    except BridgeError as exc:
        raise _error(exc) from None


@router.get("/runs/{run_id}")
def get_run(run_id: str, service: Service):
    try:
        return service.get_run(run_id)
    except BridgeError as exc:
        raise _error(exc) from None


@router.get("/runs/{run_id}/events")
def get_run_events(
    run_id: str,
    service: Service,
    after_sequence: Annotated[int, Query(ge=0)] = 0,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
):
    try:
        cursor = after_sequence
        if last_event_id:
            try:
                cursor = max(cursor, int(last_event_id))
            except ValueError:
                raise HTTPException(status_code=400, detail={"code": "LAST_EVENT_ID_INVALID"}) from None
        events = service.get_events(run_id, cursor)
    except BridgeError as exc:
        raise _error(exc) from None

    def stream():
        for event in events:
            data = json.dumps({"created_at": event["created_at"], **event["data"]}, ensure_ascii=False)
            yield f"id: {event['id']}\nevent: {event['event']}\ndata: {data}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, service: Service):
    try:
        return service.cancel(run_id)
    except BridgeError as exc:
        raise _error(exc) from None


@router.get("/tasks/{task_id}/handoff")
def get_handoff(task_id: str, service: Service):
    try:
        return service.handoff(task_id)
    except BridgeError as exc:
        raise _error(exc) from None
