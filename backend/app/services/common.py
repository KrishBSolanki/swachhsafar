import hashlib
import json
import uuid
from typing import Any, TypeVar

from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError

from app.sqlcompat import is_unique_violation
from sqlalchemy.orm import Session

from app.errors import Conflict, NotFound
from app.models import AuditLog
from app.schemas.common import PageParams

M = TypeVar("M")


def payload_hash(model: BaseModel) -> str:
    """Stable hash of a request payload, used to tell a true replay from a conflicting reuse of an id."""
    raw = json.dumps(model.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def check_replay(db: Session, model_cls: type[M], record_id: uuid.UUID, digest: str, actor_field: str, actor_id: uuid.UUID) -> M | None:
    """Return the existing record if this is an idempotent replay; raise if the id was reused differently."""
    existing = db.get(model_cls, record_id)
    if existing is None:
        return None
    if existing.payload_hash != digest or getattr(existing, actor_field) != actor_id:
        raise Conflict("This id was already used for a different record", code="idempotency_mismatch")
    return existing


def get_or_404(db: Session, model_cls: type[M], obj_id: Any, what: str | None = None) -> M:
    obj = db.get(model_cls, obj_id)
    if obj is None:
        raise NotFound(f"{what or model_cls.__name__} not found")
    return obj


def paginate(db: Session, stmt: Select, params: PageParams) -> tuple[list, int]:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    rows = db.scalars(stmt.limit(params.page_size).offset(params.offset)).unique().all()
    return list(rows), total or 0


def audit(db: Session, *, actor_id: uuid.UUID | None, action: str, entity: Any, division_id: uuid.UUID | None,
          changes: dict | None = None) -> None:
    db.add(AuditLog(
        actor_id=actor_id,
        division_id=division_id,
        action=action,
        entity_type=type(entity).__tablename__,
        entity_id=str(getattr(entity, "id", getattr(entity, "user_id", ""))),
        changes=_jsonable(changes or {}),
    ))


def diff(obj: Any, updates: dict) -> dict:
    return {k: {"from": getattr(obj, k), "to": v} for k, v in updates.items() if getattr(obj, k) != v}


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def commit_or_conflict(db: Session, message: str, code: str = "duplicate") -> None:
    """Commit; a unique-constraint violation surfaces as 409 instead of 500."""
    _unique_guard(db, db.commit, message, code)


def flush_or_conflict(db: Session, message: str, code: str = "duplicate") -> None:
    _unique_guard(db, db.flush, message, code)


def _unique_guard(db: Session, action, message: str, code: str) -> None:
    try:
        action()
    except IntegrityError as exc:
        db.rollback()
        if is_unique_violation(exc):
            raise Conflict(message, code=code) from exc
        raise
