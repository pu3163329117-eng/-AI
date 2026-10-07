"""Read-only scoped learning behavior, profile IDs are not authentication."""
from typing import Annotated
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
try:
    from backend.db.session import get_db
    from backend.db.observations import report
except ModuleNotFoundError:
    from db.session import get_db
    from db.observations import report

router = APIRouter(prefix="/api/v1/profiles")


@router.get("/{profile_id}/observations/report")
def observations_report(profile_id: str, db: Annotated[Session, Depends(get_db)]):
    return {"report": report(db, profile_id)}
