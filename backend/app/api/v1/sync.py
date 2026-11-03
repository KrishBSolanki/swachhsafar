import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import NotFound
from app.schemas.sync import ChangesOut, SyncBatchIn, SyncBatchOut, SyncResult
from app.security.principal import Principal, get_principal
from app.security.ratelimit import rate_limit
from app.services import sync as svc
from app.timeutil import utcnow

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/batch", response_model=SyncBatchOut)
def batch(body: SyncBatchIn, db: Session = Depends(get_db), p: Principal = Depends(rate_limit(60, 60))):
    """Submit outbox operations. Per op: `acknowledged` (delete from outbox), `conflict`/`rejected` (final; surface to
    the user), `retry` (keep pending, e.g. media upload not finished). Re-sending an op_id returns the stored outcome."""
    return SyncBatchOut(server_time=utcnow(), results=svc.process_batch(db, p, body))


@router.get("/operations/{op_id}", response_model=SyncResult)
def operation(op_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Recover the outcome of an operation whose batch response was lost."""
    result = svc.get_operation(db, p, op_id)
    if result is None:
        raise NotFound("Operation not received")
    return result


@router.get("/changes", response_model=ChangesOut)
def changes(since: datetime | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Incremental master data and journey download. Store `cursor` and pass it as `since` next time."""
    return svc.changes(db, p, since)
