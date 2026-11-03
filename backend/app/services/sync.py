import logging
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.errors import AppError, Conflict
from app.models import (
    ComplaintCategory,
    ComplaintDepartment,
    Division,
    InventoryItem,
    Journey,
    QuestionBank,
    StaffAllocation,
    SyncOperation,
    Train,
)
from app.schemas.complaints import CategoryOut, ComplaintIn, DepartmentOut
from app.schemas.feedback import PassengerFeedbackStart, QuestionBankOut, RailwayFeedbackIn
from app.schemas.inventory import ItemOut, TxnIn
from app.schemas.journeys import JourneyOut
from app.schemas.operations import AttendanceIn, InspectionIn
from app.schemas.org import DivisionOut
from app.schemas.sync import SyncBatchIn
from app.schemas.trains import TrainOut
from app.security.principal import Principal
from app.services import attendance, complaints, feedback, inspections, inventory
from app.services import journeys as journey_svc
from app.services.policy import get_policy

# Records may commit slightly out of updated_at order; re-sending a small window keeps deltas lossless.
CURSOR_OVERLAP = timedelta(seconds=120)
log = logging.getLogger(__name__)

Handler = Callable[[Session, Principal, BaseModel, uuid.UUID], tuple[object, bool]]

HANDLERS: dict[str, tuple[type[BaseModel], Handler]] = {
    "attendance.create": (AttendanceIn, lambda db, p, b, op: attendance.create(db, p, b, sync_op_id=op, commit=False)),
    "inspection.create": (InspectionIn, lambda db, p, b, op: inspections.create(db, p, b, sync_op_id=op, commit=False)),
    "feedback.passenger.start": (PassengerFeedbackStart, lambda db, p, b, op: _passenger_start(db, p, b)),
    "feedback.railway.create": (RailwayFeedbackIn, lambda db, p, b, op: feedback.create_railway(db, p, b, commit=False)),
    "complaint.create": (ComplaintIn, lambda db, p, b, op: complaints.create(db, p, b, commit=False)),
    "inventory.record": (TxnIn, lambda db, p, b, op: inventory.record(db, p, b, commit=False)),
}

# Errors that a later retry can resolve (dependency not ready / transient). Everything else is final.
RETRYABLE_CODES = {"media_pending", "pnr_unavailable", "sms_unavailable", "service_unavailable", "rate_limited"}


def _passenger_start(db: Session, p: Principal, body: PassengerFeedbackStart):
    # start_passenger commits on its own; verification (PNR/OTP) always needs a live online step afterwards.
    return feedback.start_passenger(db, p, body)


def process_batch(db: Session, p: Principal, body: SyncBatchIn) -> list[dict]:
    results = []
    for op in body.operations:
        stored = db.get(SyncOperation, op.op_id)
        if stored is not None:
            if stored.user_id != p.id:
                results.append(dict(op_id=op.op_id, type=op.type, outcome="rejected", http_status=409,
                                    error={"code": "op_id_reused", "message": "Operation id belongs to another user"}))
                continue
            results.append({**stored.result, "replayed": True})
            continue
        results.append(_run(db, p, body.device_id, op.op_id, op.type, op.payload))
    return results


def _run(db: Session, p: Principal, device_id: str, op_id: uuid.UUID, op_type: str, payload: dict) -> dict:
    schema, handler = HANDLERS[op_type]
    entity_id = payload.get("id")
    base = dict(op_id=op_id, type=op_type)
    try:
        model = schema.model_validate(payload)
    except ValidationError as exc:
        errors = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        return _store(db, p, device_id, op_type, entity_id, dict(base, outcome="rejected", http_status=422,
                      error={"code": "validation_error", "message": "Payload validation failed", "details": errors}))
    savepoint = db.begin_nested()
    try:
        record, replayed = handler(db, p, model, op_id)
        if savepoint.is_active:
            savepoint.commit()
        db.commit()
    except AppError as exc:
        if savepoint.is_active:
            savepoint.rollback()
        db.rollback()
        result = dict(base, http_status=exc.status_code, error={"code": exc.code, "message": exc.message, "details": exc.details})
        if exc.code in RETRYABLE_CODES or exc.status_code >= 500:
            return dict(result, outcome="retry")  # not stored: the device keeps the op pending and resends it
        return _store(db, p, device_id, op_type, model.id, dict(result, outcome="conflict" if isinstance(exc, Conflict) else "rejected"))
    except Exception:
        log.exception("sync op %s (%s) failed", op_id, op_type)
        db.rollback()
        return dict(base, outcome="retry", http_status=500, error={"code": "internal_error", "message": "Unexpected server error"})
    return _store(db, p, device_id, op_type, model.id, dict(base, outcome="acknowledged", http_status=200 if replayed else 201,
                  entity_id=model.id, replayed=replayed, server_timestamp=getattr(record, "server_timestamp", None)
                  or getattr(record, "created_at", None)))


def _store(db: Session, p: Principal, device_id: str, op_type: str, entity_id, result: dict) -> dict:
    try:
        entity_uuid = uuid.UUID(str(entity_id))
    except (TypeError, ValueError):
        return result  # unparseable payload id: nothing to key the outcome on; client must fix the record
    db.add(SyncOperation(op_id=result["op_id"], user_id=p.id, device_id=device_id, op_type=op_type, entity_id=entity_uuid,
                         outcome=result["outcome"], http_status=result["http_status"],
                         result={k: (str(v) if isinstance(v, (uuid.UUID, datetime)) else v) for k, v in result.items()}))
    db.commit()
    return result


def get_operation(db: Session, p: Principal, op_id: uuid.UUID) -> dict | None:
    stored = db.get(SyncOperation, op_id)
    if stored is None or stored.user_id != p.id:
        return None
    return {**stored.result, "replayed": True}


def changes(db: Session, p: Principal, since: datetime | None) -> dict:
    cursor = db.scalar(select(func.now()))
    after = since - CURSOR_OVERLAP if since else None
    divisions = p.scope_divisions()

    def newer(col):
        return [col > after] if after else []

    trains = db.scalars(select(Train).options(selectinload(Train.coaches))
                        .where(Train.division_id.in_(divisions), *newer(Train.updated_at))).all()
    items = db.scalars(select(InventoryItem).where(InventoryItem.division_id.in_(divisions), *newer(InventoryItem.updated_at))).all()
    banks = db.scalars(select(QuestionBank).options(selectinload(QuestionBank.questions)).where(
        or_(QuestionBank.division_id.in_(divisions), QuestionBank.division_id.is_(None)), *newer(QuestionBank.updated_at))).all()
    deps = db.scalars(select(ComplaintDepartment).where(ComplaintDepartment.division_id.in_(divisions), *newer(ComplaintDepartment.updated_at))).all()
    cats = db.scalars(select(ComplaintCategory).where(ComplaintCategory.division_id.in_(divisions), *newer(ComplaintCategory.updated_at))).all()
    div_rows = db.scalars(select(Division).where(Division.id.in_(divisions), *newer(Division.updated_at))).all()

    jstmt = select(Journey).options(selectinload(Journey.coaches)).where(
        Journey.division_id.in_(divisions), Journey.end_date >= func.current_date() - 7)
    full_divs = [d for d in divisions if p.has("journeys.read_all", d)]
    involved = or_(Journey.supervisor_id == p.id, Journey.id.in_(select(StaffAllocation.journey_id).where(StaffAllocation.user_id == p.id)))
    jstmt = jstmt.where(or_(Journey.division_id.in_(full_divs), involved) if full_divs else involved)
    if after:
        touched = select(StaffAllocation.journey_id).where(StaffAllocation.updated_at > after)
        jstmt = jstmt.where(or_(Journey.updated_at > after, Journey.id.in_(touched)))
    journeys = []
    for j in db.scalars(jstmt).unique():
        if not journey_svc.can_see(db, p, j):
            continue
        out = JourneyOut.model_validate(journey_svc.to_out(j)).model_dump(mode="json")
        out["staff"] = [{k: str(v) if v is not None and not isinstance(v, int) else v for k, v in s.items()}
                        for s in journey_svc.list_staff(db, p, j.id, include_removed=True)]
        journeys.append(out)

    dump = lambda schema, rows: [schema.model_validate(r).model_dump(mode="json") for r in rows]  # noqa: E731
    return dict(
        cursor=cursor, full=since is None,
        divisions=dump(DivisionOut, div_rows),
        policies={str(d): get_policy(db, d).model_dump() for d in divisions},
        trains=dump(TrainOut, trains), inventory_items=dump(ItemOut, items), question_banks=dump(QuestionBankOut, banks),
        complaint_departments=dump(DepartmentOut, deps), complaint_categories=dump(CategoryOut, cats), journeys=journeys,
    )

