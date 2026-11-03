"""Local-only ability projections and explicit learning-path writes."""
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session
try:
    from backend.db.session import get_db
    from backend.db import learning_path as store
    from backend.access import student_response
except ModuleNotFoundError:
    from db.session import get_db
    from db import learning_path as store
    from access import student_response

router = APIRouter(prefix="/api/v1/profiles")
Db = Annotated[Session, Depends(get_db)]
Key = Annotated[str | None, Header(alias="Idempotency-Key")]


class GeneratePlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    practice_level: Literal["L1", "L2", "L3"] | None = None


class StartTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


def key_required(key):
    if not key or not key.strip() or len(key) > 255:
        store.fail("IDEMPOTENCY_KEY_REQUIRED", 400)
    return key


@router.get("/{profile_id}/ability")
def get_ability(profile_id: str, db: Db):
    return {"ability": store.ability(db, profile_id)}


@router.get("/{profile_id}/recommendations")
def get_recommendations(profile_id: str, db: Db):
    return store.get_plan(db, profile_id)


@router.post("/{profile_id}/recommendations")
def generate_recommendations(profile_id: str, request: GeneratePlanRequest, response: Response, db: Db, idempotency_key: Key = None):
    result, created = store.generate(db, profile_id, request.practice_level, key_required(idempotency_key))
    response.status_code = 201 if created else 200
    return result


@router.post("/{profile_id}/recommendations/{task_id}/start")
def start_recommendation(profile_id: str, task_id: str, request: StartTaskRequest, db: Db, idempotency_key: Key = None):
    return student_response(store.start(db, profile_id, task_id, key_required(idempotency_key)))
