from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
from functools import wraps
import json
import threading
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .contracts import CreateManifestRequest, CreateRunRequest, CreateTaskRequest, FollowUpRequest
from .models import AuditEvent, CollaborationArtifact, CollaborationMessage, CollaborationRun, CollaborationTask, ContextManifest
from .runtime import AdapterResult, HarnessAdapter, RunCancelled, RunEnvelope, RuntimeFailure


TERMINAL_STATUSES = {"WAITING_REVIEW", "ACCEPTED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"}


class BridgeError(RuntimeError):
    def __init__(self, status_code: int, code: str, **details: Any):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.details = details


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(value if isinstance(value, bytes) else _canonical(value)).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def serialized(method):
    """Serialize API/worker transactions, including audit sequence allocation."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._transaction_lock:
            return method(self, *args, **kwargs)
    return wrapped


class CollaborationService:
    def __init__(self, session_factory: Callable[[], Session], adapter: HarnessAdapter):
        self.session_factory = session_factory
        self.adapter = adapter
        self.wake_worker: Callable[[], None] = lambda: None
        self._cancel_events: dict[str, threading.Event] = {}
        self._cancel_lock = threading.Lock()
        self._transaction_lock = threading.RLock()

    def _audit(self, db: Session, event_type: str, *, task_id: str | None = None,
               run_id: str | None = None, actor: str = "bridge-api",
               details: dict[str, Any] | None = None, as_run_event: bool = False) -> AuditEvent:
        sequence = None
        if as_run_event and run_id:
            sequence = (db.scalar(select(func.max(AuditEvent.run_sequence)).where(AuditEvent.run_id == run_id)) or 0) + 1
        event = AuditEvent(
            id=str(uuid.uuid4()), task_id=task_id, run_id=run_id, run_sequence=sequence,
            actor=actor, event_type=event_type, details=details or {},
        )
        db.add(event)
        db.flush()
        return event

    @staticmethod
    def _manifest_payload(record: ContextManifest) -> dict[str, Any]:
        return {
            "id": record.id, "task_id": record.task_id, "version": record.version,
            "items": record.items, "authorization_scope": record.authorization_scope,
            "content_sha256": record.content_sha256, "byte_count": record.byte_count,
            "truncated": record.truncated, "created_at": _iso(record.created_at),
        }

    @staticmethod
    def _run_payload(db: Session, record: CollaborationRun) -> dict[str, Any]:
        artifacts = db.scalars(select(CollaborationArtifact).where(CollaborationArtifact.run_id == record.id).order_by(CollaborationArtifact.created_at)).all()
        manifest = db.get(ContextManifest, record.manifest_id)
        task = db.get(CollaborationTask, record.task_id)
        return {
            "id": record.id, "task_id": record.task_id, "manifest_id": record.manifest_id,
            "parent_run_id": record.parent_run_id, "request_message_id": record.request_message_id,
            "status": record.status, "runtime": record.runtime,
            "harness_session_id": record.harness_session_id,
            "harness_message_id": record.harness_message_id,
            "outcome_code": record.outcome_code,
            "cancellation_requested": record.cancellation_requested,
            "input_manifest_version": manifest.version,
            "needs_revalidation": manifest.version < task.current_manifest_version,
            "limits": record.limits,
            "created_at": _iso(record.created_at), "started_at": _iso(record.started_at),
            "completed_at": _iso(record.completed_at),
            "artifacts": [{
                "id": artifact.id, "kind": artifact.kind, "review_status": artifact.review_status,
                "payload": artifact.payload, "content_sha256": artifact.content_sha256,
                "created_at": _iso(artifact.created_at),
            } for artifact in artifacts],
        }

    @serialized
    def create_task(self, request: CreateTaskRequest) -> dict[str, Any]:
        task_id = str(uuid.uuid4())
        items = [item.model_dump() for item in request.context_items]
        manifest_bytes = _canonical(items)
        if len(manifest_bytes) > request.max_context_bytes:
            raise BridgeError(413, "CONTEXT_BUDGET_EXCEEDED", byte_count=len(manifest_bytes), max_context_bytes=request.max_context_bytes)
        task = CollaborationTask(
            id=task_id, project_id=request.project_id, title=request.title, objective=request.objective,
            acceptance_criteria=request.acceptance_criteria, forbidden_actions=request.forbidden_actions,
            status="OPEN", harness_session_id=f"collab-{task_id}", current_manifest_version=1,
        )
        manifest = ContextManifest(
            id=str(uuid.uuid4()), task_id=task_id, version=1, items=items,
            authorization_scope={
                "classifications": sorted({item["classification"] for item in items}),
                "read_only": True, "learner_records": False, "shell": False,
                "publish": False, "approval": False,
            },
            content_sha256=_digest(manifest_bytes), request_sha256=_digest(items), idempotency_key="task:create",
            byte_count=len(manifest_bytes), truncated=False,
        )
        with self.session_factory() as db:
            db.add_all([task, manifest])
            self._audit(db, "task.created", task_id=task_id, details={"manifest_id": manifest.id, "manifest_sha256": manifest.content_sha256})
            db.commit()
            return {"task": self._task_payload(task), "context_manifest": self._manifest_payload(manifest)}

    @serialized
    def create_manifest(self, task_id: str, request: CreateManifestRequest, key: str) -> tuple[dict[str, Any], bool]:
        if not key or len(key) > 120:
            raise BridgeError(400, "IDEMPOTENCY_KEY_REQUIRED")
        items = [item.model_dump() for item in request.context_items]
        manifest_bytes = _canonical(items)
        if len(manifest_bytes) > request.max_context_bytes:
            raise BridgeError(413, "CONTEXT_BUDGET_EXCEEDED", byte_count=len(manifest_bytes), max_context_bytes=request.max_context_bytes)
        request_sha = _digest({
            "expected_current_version": request.expected_current_version,
            "items": items,
            "max_context_bytes": request.max_context_bytes,
        })
        with self.session_factory() as db:
            task = db.get(CollaborationTask, task_id)
            if not task:
                raise BridgeError(404, "TASK_NOT_FOUND")
            existing = db.scalar(select(ContextManifest).where(ContextManifest.task_id == task_id, ContextManifest.idempotency_key == key))
            if existing:
                if existing.request_sha256 != request_sha:
                    raise BridgeError(409, "IDEMPOTENCY_KEY_REUSED")
                return self._manifest_payload(existing), False
            if task.current_manifest_version != request.expected_current_version:
                raise BridgeError(409, "CONTEXT_MANIFEST_VERSION_CONFLICT", current_version=task.current_manifest_version)
            manifest = ContextManifest(
                id=str(uuid.uuid4()), task_id=task_id, version=task.current_manifest_version + 1,
                items=items,
                authorization_scope={
                    "classifications": sorted({item["classification"] for item in items}),
                    "read_only": True, "learner_records": False, "shell": False,
                    "publish": False, "approval": False,
                },
                content_sha256=_digest(manifest_bytes), request_sha256=request_sha,
                idempotency_key=key, byte_count=len(manifest_bytes), truncated=False,
            )
            db.add(manifest)
            task.current_manifest_version = manifest.version
            self._audit(db, "context_manifest.created", task_id=task_id, details={
                "manifest_id": manifest.id, "version": manifest.version,
                "content_sha256": manifest.content_sha256,
                "prior_results_require_revalidation": True,
            })
            db.commit()
            return self._manifest_payload(manifest), True

    @staticmethod
    def _task_payload(task: CollaborationTask) -> dict[str, Any]:
        return {
            "id": task.id, "project_id": task.project_id, "title": task.title,
            "objective": task.objective, "acceptance_criteria": task.acceptance_criteria,
            "forbidden_actions": task.forbidden_actions, "status": task.status,
            "harness_session_id": task.harness_session_id,
            "current_manifest_version": task.current_manifest_version,
            "created_at": _iso(task.created_at), "updated_at": _iso(task.updated_at),
        }

    def _create_run(self, db: Session, task: CollaborationTask, manifest: ContextManifest,
                    *, prompt: str, key: str, max_output_tokens: int, timeout_seconds: int,
                    parent_run_id: str | None = None) -> CollaborationRun:
        request_value = {
            "prompt": prompt, "manifest_version": manifest.version,
            "max_output_tokens": max_output_tokens, "timeout_seconds": timeout_seconds,
            "parent_run_id": parent_run_id,
        }
        request_sha = _digest(request_value)
        existing = db.scalar(select(CollaborationRun).where(CollaborationRun.task_id == task.id, CollaborationRun.idempotency_key == key))
        if existing:
            if existing.request_sha256 != request_sha:
                raise BridgeError(409, "IDEMPOTENCY_KEY_REUSED")
            return existing
        sequence = (db.scalar(select(func.max(CollaborationMessage.sequence)).where(CollaborationMessage.task_id == task.id)) or 0) + 1
        run_id = str(uuid.uuid4())
        message = CollaborationMessage(
            id=str(uuid.uuid4()), task_id=task.id, run_id=run_id, role="user", content=prompt,
            content_sha256=_digest(prompt.encode("utf-8")), idempotency_key=f"run:{key}", sequence=sequence,
        )
        run = CollaborationRun(
            id=run_id, task_id=task.id, manifest_id=manifest.id, parent_run_id=parent_run_id,
            request_message_id=message.id, idempotency_key=key, request_sha256=request_sha,
            limits={"max_output_tokens": max_output_tokens, "timeout_seconds": timeout_seconds},
            status="QUEUED", runtime=self.adapter.name,
            # No native persistent session restore has been proven. The stdio
            # adapter uses a fresh session and replays scoped Bridge history.
            harness_session_id=f"collab-{task.id}-{run_id}" if self.adapter.name == "dsh-stdio" else task.harness_session_id,
        )
        db.add_all([message, run])
        self._audit(db, "run.queued", task_id=task.id, run_id=run.id, details={"manifest_id": manifest.id, "request_sha256": request_sha}, as_run_event=True)
        return run

    @serialized
    def create_run(self, task_id: str, request: CreateRunRequest, key: str) -> tuple[dict[str, Any], bool]:
        if not key or len(key) > 120:
            raise BridgeError(400, "IDEMPOTENCY_KEY_REQUIRED")
        with self.session_factory() as db:
            task = db.get(CollaborationTask, task_id)
            if not task:
                raise BridgeError(404, "TASK_NOT_FOUND")
            manifest = db.scalar(select(ContextManifest).where(ContextManifest.task_id == task_id, ContextManifest.version == request.manifest_version))
            if not manifest:
                raise BridgeError(409, "CONTEXT_MANIFEST_VERSION_NOT_FOUND")
            if request.manifest_version != task.current_manifest_version:
                raise BridgeError(409, "CONTEXT_MANIFEST_STALE", current_version=task.current_manifest_version)
            before = db.scalar(select(CollaborationRun.id).where(CollaborationRun.task_id == task_id, CollaborationRun.idempotency_key == key))
            run = self._create_run(db, task, manifest, prompt=request.prompt, key=key,
                                   max_output_tokens=request.max_output_tokens, timeout_seconds=request.timeout_seconds)
            created = before is None
            db.commit()
            payload = self._run_payload(db, run)
        if created:
            self.wake_worker()
        return payload, created

    @serialized
    def append_message(self, task_id: str, request: FollowUpRequest, key: str) -> tuple[dict[str, Any], bool]:
        if not key or len(key) > 120:
            raise BridgeError(400, "IDEMPOTENCY_KEY_REQUIRED")
        with self.session_factory() as db:
            task = db.get(CollaborationTask, task_id)
            if not task:
                raise BridgeError(404, "TASK_NOT_FOUND")
            manifest = db.scalar(select(ContextManifest).where(ContextManifest.task_id == task_id, ContextManifest.version == request.manifest_version))
            if not manifest:
                raise BridgeError(409, "CONTEXT_MANIFEST_VERSION_NOT_FOUND")
            if request.manifest_version != task.current_manifest_version:
                raise BridgeError(409, "CONTEXT_MANIFEST_STALE", current_version=task.current_manifest_version)
            parent = db.scalar(select(CollaborationRun).where(CollaborationRun.task_id == task_id).order_by(CollaborationRun.created_at.desc()))
            existing = db.scalar(select(CollaborationRun).where(CollaborationRun.task_id == task_id, CollaborationRun.idempotency_key == f"followup:{key}"))
            before = existing.id if existing else None
            run = self._create_run(
                db, task, manifest, prompt=request.content, key=f"followup:{key}",
                max_output_tokens=request.max_output_tokens, timeout_seconds=request.timeout_seconds,
                parent_run_id=existing.parent_run_id if existing else parent.id if parent else None,
            )
            created = before is None
            db.commit()
            message = db.get(CollaborationMessage, run.request_message_id)
            payload = {"message_id": message.id, "run": self._run_payload(db, run), "queued_behind_active_run": self._has_earlier_active(db, run)}
        if created:
            self.wake_worker()
        return payload, created

    @staticmethod
    def _has_earlier_active(db: Session, run: CollaborationRun) -> bool:
        return bool(db.scalar(select(CollaborationRun.id).where(
            CollaborationRun.id != run.id,
            CollaborationRun.status.in_(["QUEUED", "RUNNING"]),
            CollaborationRun.created_at <= run.created_at,
        ).limit(1)))

    @serialized
    def get_run(self, run_id: str) -> dict[str, Any]:
        with self.session_factory() as db:
            run = db.get(CollaborationRun, run_id)
            if not run:
                raise BridgeError(404, "RUN_NOT_FOUND")
            return self._run_payload(db, run)

    @serialized
    def get_events(self, run_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
        with self.session_factory() as db:
            if not db.get(CollaborationRun, run_id):
                raise BridgeError(404, "RUN_NOT_FOUND")
            events = db.scalars(select(AuditEvent).where(
                AuditEvent.run_id == run_id, AuditEvent.run_sequence.is_not(None), AuditEvent.run_sequence > after_sequence,
            ).order_by(AuditEvent.run_sequence)).all()
            return [{
                "id": event.run_sequence, "event": event.event_type, "data": event.details,
                "created_at": _iso(event.created_at),
            } for event in events]

    @serialized
    def cancel(self, run_id: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        with self.session_factory() as db:
            run = db.get(CollaborationRun, run_id)
            if not run:
                raise BridgeError(404, "RUN_NOT_FOUND")
            if run.status in TERMINAL_STATUSES:
                return self._run_payload(db, run)
            run.cancellation_requested = True
            if run.status == "QUEUED":
                run.status = "CANCELLED"
                run.outcome_code = "CANCELLED_BEFORE_START"
                run.completed_at = now
                self._audit(db, "run.cancelled", task_id=run.task_id, run_id=run.id, details={"before_start": True}, as_run_event=True)
            else:
                self._audit(db, "run.cancel_requested", task_id=run.task_id, run_id=run.id, details={"provider_stop_not_guaranteed": True}, as_run_event=True)
            db.commit()
            payload = self._run_payload(db, run)
        with self._cancel_lock:
            event = self._cancel_events.get(run_id)
            if event:
                event.set()
        self.adapter.cancel(run_id)
        return payload

    @serialized
    def recover_interrupted(self) -> int:
        with self.session_factory() as db:
            runs = db.scalars(select(CollaborationRun).where(CollaborationRun.status == "RUNNING")).all()
            for run in runs:
                run.status = "OUTCOME_UNKNOWN"
                run.outcome_code = "BRIDGE_RESTARTED_AFTER_DISPATCH"
                run.completed_at = datetime.now(timezone.utc)
                self._audit(db, "run.outcome_unknown", task_id=run.task_id, run_id=run.id,
                            actor="bridge-recovery", details={"automatic_retry": False}, as_run_event=True)
            db.commit()
            return len(runs)

    def cancel_active_runs(self) -> int:
        with self.session_factory() as db:
            run_ids = list(db.scalars(select(CollaborationRun.id).where(CollaborationRun.status == "RUNNING")))
        for run_id in run_ids:
            self.cancel(run_id)
        return len(run_ids)

    @serialized
    def claim_next_run(self) -> str | None:
        with self.session_factory() as db:
            if db.scalar(select(CollaborationRun.id).where(CollaborationRun.status == "RUNNING").limit(1)):
                return None
            run = db.scalar(select(CollaborationRun).where(CollaborationRun.status == "QUEUED").order_by(CollaborationRun.created_at, CollaborationRun.id).limit(1))
            if not run:
                return None
            run.status = "RUNNING"
            run.started_at = datetime.now(timezone.utc)
            self._audit(db, "run.started", task_id=run.task_id, run_id=run.id, actor="bridge-worker",
                        details={"runtime": run.runtime}, as_run_event=True)
            db.commit()
            return run.id

    def _safe_runtime_details(self, event_type: str, details: dict[str, Any]) -> dict[str, Any]:
        if event_type == "runtime.assistant_message" and "text" in details:
            text = str(details["text"])
            return {"content_sha256": _digest(text.encode("utf-8")), "byte_count": len(text.encode("utf-8")), "synthetic": bool(details.get("synthetic"))}
        return details

    @serialized
    def _build_envelope(self, run_id: str, cancel_event: threading.Event) -> RunEnvelope | None:
        with self.session_factory() as db:
            run = db.get(CollaborationRun, run_id)
            if not run or run.status != "RUNNING":
                return None
            if run.cancellation_requested:
                cancel_event.set()
            task = db.get(CollaborationTask, run.task_id)
            manifest = db.get(ContextManifest, run.manifest_id)
            message = db.get(CollaborationMessage, run.request_message_id)
            prior = db.scalars(select(CollaborationMessage).where(
                CollaborationMessage.task_id == run.task_id,
                CollaborationMessage.role == "user", CollaborationMessage.sequence < message.sequence,
            ).order_by(CollaborationMessage.sequence)).all()
            history = []
            omitted = 0
            for user_message in prior:
                old_run = db.get(CollaborationRun, user_message.run_id)
                # Changes to the authorized manifest must not silently replay
                # removed evidence. Failed/unknown/cancelled turns are not facts.
                if not old_run or old_run.manifest_id != run.manifest_id or old_run.status not in {"WAITING_REVIEW", "ACCEPTED"}:
                    omitted += 1
                    continue
                old_messages = db.scalars(select(CollaborationMessage).where(
                    CollaborationMessage.task_id == run.task_id, CollaborationMessage.run_id == old_run.id,
                ).order_by(CollaborationMessage.sequence)).all()
                for old_message in old_messages:
                    history.append({
                        "message_id": old_message.id, "run_id": old_run.id,
                        "input_manifest_id": old_run.manifest_id, "role": old_message.role,
                        "content": old_message.content, "content_sha256": old_message.content_sha256,
                        "interpretation": "user_request" if old_message.role == "user" else "unverified_model_candidate",
                    })
            if len(_canonical(history)) > 65_536:
                raise RuntimeFailure("DSH_HISTORY_BYTE_LIMIT")
            policy = {"mode": "bridge_replay", "native_session_restore_verified": False,
                      "same_task_only": True, "same_manifest_only": True,
                      "omitted_runs": omitted, "model_candidates_grant_authority": False,
                      "max_history_bytes": 65_536, "truncated": False}
            envelope = RunEnvelope(
                run_id=run.id, task_id=run.task_id, session_id=run.harness_session_id,
                prompt=message.content,
                task_spec={
                    "task_id": task.id, "project_id": task.project_id, "title": task.title,
                    "objective": task.objective, "acceptance_criteria": task.acceptance_criteria,
                    "forbidden_actions": task.forbidden_actions,
                },
                manifest=self._manifest_payload(manifest),
                max_output_tokens=int(run.limits["max_output_tokens"]), timeout_seconds=int(run.limits["timeout_seconds"]),
                history=history, history_policy=policy,
            )
            history_sha = _digest(history)
            self._audit(db, "runtime.context_prepared", task_id=run.task_id, run_id=run.id,
                        actor="bridge-worker", details={"manifest_id": manifest.id, "manifest_sha256": manifest.content_sha256,
                                                      "history_sha256": history_sha, "history_message_ids": [item["message_id"] for item in history],
                                                      "history_policy": policy}, as_run_event=True)
            db.commit()
            return envelope

    def execute_run(self, run_id: str) -> None:
        cancel_event = threading.Event()
        with self._cancel_lock:
            self._cancel_events[run_id] = cancel_event

        def emit(event_type: str, details: dict[str, Any]) -> None:
            with self._transaction_lock, self.session_factory() as event_db:
                event_run = event_db.get(CollaborationRun, run_id)
                if not event_run:
                    return
                if event_type == "runtime.message_enqueued" and details.get("message_id"):
                    event_run.harness_message_id = str(details["message_id"])
                self._audit(event_db, event_type, task_id=event_run.task_id, run_id=run_id,
                            actor="harness-adapter", details=self._safe_runtime_details(event_type, details), as_run_event=True)
                event_db.commit()

        try:
            envelope = self._build_envelope(run_id, cancel_event)
            if envelope is None:
                return
            result = self.adapter.run(envelope, emit, cancel_event)
            self._complete_success(run_id, result)
        except RunCancelled:
            self._complete_failure(run_id, "CANCELLED", "CANCELLED_AFTER_START")
        except RuntimeFailure as exc:
            self._complete_failure(run_id, "OUTCOME_UNKNOWN" if exc.outcome_unknown else "FAILED", exc.code)
        except Exception:
            self._complete_failure(run_id, "OUTCOME_UNKNOWN", "ADAPTER_UNEXPECTED_FAILURE")
        finally:
            with self._cancel_lock:
                self._cancel_events.pop(run_id, None)

    @serialized
    def _complete_success(self, run_id: str, result: AdapterResult) -> None:
        with self.session_factory() as db:
            run = db.get(CollaborationRun, run_id)
            if not run:
                return
            if run.cancellation_requested:
                run.status = "CANCELLED"
                run.outcome_code = "CANCELLED_RESULT_DISCARDED"
                event_type = "run.cancelled"
                details = {"result_discarded": True, "provider_stop_not_guaranteed": True}
            else:
                payload = {"text": result.text, "metadata": result.metadata, "input_manifest_id": run.manifest_id}
                artifact = CollaborationArtifact(
                    id=str(uuid.uuid4()), task_id=run.task_id, run_id=run.id, kind="MODEL_RESULT",
                    review_status="CANDIDATE", payload=payload, content_sha256=_digest(payload),
                )
                db.add(artifact)
                sequence = (db.scalar(select(func.max(CollaborationMessage.sequence)).where(CollaborationMessage.task_id == run.task_id)) or 0) + 1
                db.add(CollaborationMessage(
                    id=str(uuid.uuid4()), task_id=run.task_id, run_id=run.id, role="assistant", content=result.text,
                    content_sha256=_digest(result.text.encode("utf-8")), idempotency_key=f"result:{run.id}", sequence=sequence,
                ))
                run.status = "WAITING_REVIEW"
                run.outcome_code = "RESULT_REQUIRES_REVIEW"
                run.harness_message_id = result.harness_message_id
                event_type = "run.completed"
                details = {"artifact_id": artifact.id, "review_status": "CANDIDATE", "manifest_id": run.manifest_id}
            run.completed_at = datetime.now(timezone.utc)
            self._audit(db, event_type, task_id=run.task_id, run_id=run.id, actor="bridge-worker", details=details, as_run_event=True)
            db.commit()

    @serialized
    def _complete_failure(self, run_id: str, status: str, code: str) -> None:
        with self.session_factory() as db:
            run = db.get(CollaborationRun, run_id)
            if not run:
                return
            run.status = status
            run.outcome_code = code
            run.completed_at = datetime.now(timezone.utc)
            event_type = "run.outcome_unknown" if status == "OUTCOME_UNKNOWN" else "run.cancelled" if status == "CANCELLED" else "run.failed"
            self._audit(db, event_type, task_id=run.task_id, run_id=run.id, actor="bridge-worker",
                        details={"code": code, "automatic_retry": False}, as_run_event=True)
            db.commit()

    @serialized
    def handoff(self, task_id: str) -> dict[str, Any]:
        with self.session_factory() as db:
            task = db.get(CollaborationTask, task_id)
            if not task:
                raise BridgeError(404, "TASK_NOT_FOUND")
            manifests = db.scalars(select(ContextManifest).where(ContextManifest.task_id == task_id).order_by(ContextManifest.version)).all()
            runs = db.scalars(select(CollaborationRun).where(CollaborationRun.task_id == task_id).order_by(CollaborationRun.created_at)).all()
            messages = db.scalars(select(CollaborationMessage).where(CollaborationMessage.task_id == task_id).order_by(CollaborationMessage.sequence)).all()
            audits = db.scalars(select(AuditEvent).where(AuditEvent.task_id == task_id).order_by(AuditEvent.created_at, AuditEvent.id)).all()
            return {
                "task": self._task_payload(task),
                "context_manifests": [self._manifest_payload(item) for item in manifests],
                "messages": [{
                    "id": item.id, "run_id": item.run_id, "role": item.role,
                    "content": item.content, "content_sha256": item.content_sha256,
                    "sequence": item.sequence, "created_at": _iso(item.created_at),
                } for item in messages],
                "runs": [self._run_payload(db, item) for item in runs],
                "audit_events": [{
                    "id": item.id, "run_id": item.run_id, "run_sequence": item.run_sequence,
                    "actor": item.actor, "event_type": item.event_type,
                    "details": item.details, "created_at": _iso(item.created_at),
                } for item in audits],
                "verification": {
                    "model_outputs_are_candidates": True,
                    "facts_or_permissions_inferred_from_model_output": False,
                    "automatic_retry_of_unknown_outcomes": False,
                },
            }


class CollaborationWorker:
    def __init__(self, service: CollaborationService):
        self.service = service
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        service.wake_worker = self.wake

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="collaboration-worker", daemon=True)
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self.service.cancel_active_runs()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.is_set():
            run_id = self.service.claim_next_run()
            if run_id:
                self.service.execute_run(run_id)
                continue
            self._wake.wait(0.5)
            self._wake.clear()
