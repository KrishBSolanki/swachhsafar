import uuid
from datetime import timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation, Forbidden
from app.models import InventoryItem, InventoryTransaction, InventoryTxnType, JourneyState
from app.schemas.common import PageParams
from app.schemas.inventory import ItemIn, ItemUpdate, TxnIn
from app.security.principal import Principal
from app.services.common import (
    audit,
    check_replay,
    commit_or_conflict,
    diff,
    flush_or_conflict,
    get_or_404,
    paginate,
    payload_hash,
)
from app.services.journeys import get_journey, is_allocated, journey_state
from app.services.policy import get_policy
from app.timeutil import today_ist


def create_item(db: Session, p: Principal, body: ItemIn) -> InventoryItem:
    p.require("inventory.items.manage", body.division_id)
    item = InventoryItem(**body.model_dump())
    db.add(item)
    flush_or_conflict(db, "Item already exists in this division")
    audit(db, actor_id=p.id, action="inventory_item.create", entity=item, division_id=item.division_id, changes=body.model_dump(mode="json"))
    commit_or_conflict(db, "Item already exists in this division")
    return item


def update_item(db: Session, p: Principal, item_id: uuid.UUID, body: ItemUpdate) -> InventoryItem:
    item = get_or_404(db, InventoryItem, item_id, "Item")
    p.require("inventory.items.manage", item.division_id)
    updates = body.model_dump(exclude_unset=True)
    audit(db, actor_id=p.id, action="inventory_item.update", entity=item, division_id=item.division_id, changes=diff(item, updates))
    for k, v in updates.items():
        setattr(item, k, v)
    commit_or_conflict(db, "Item already exists in this division")
    return item


def list_items(db: Session, p: Principal, division_id: uuid.UUID, active: bool | None, updated_since=None) -> list[InventoryItem]:
    if not p.can_access_division(division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    stmt = select(InventoryItem).where(InventoryItem.division_id == division_id)
    if active is not None:
        stmt = stmt.where(InventoryItem.is_active.is_(active))
    if updated_since is not None:
        stmt = stmt.where(InventoryItem.updated_at > updated_since)
    return list(db.scalars(stmt.order_by(InventoryItem.name)))


def _outstanding(db: Session, journey_id, item_id, coach_code) -> float:
    signed = case((InventoryTransaction.txn_type == InventoryTxnType.ISSUE, InventoryTransaction.quantity),
                  else_=-InventoryTransaction.quantity)
    stmt = select(func.coalesce(func.sum(signed), 0)).where(
        InventoryTransaction.journey_id == journey_id, InventoryTransaction.item_id == item_id)
    stmt = stmt.where(InventoryTransaction.coach_code.is_(None) if coach_code is None else InventoryTransaction.coach_code == coach_code)
    return float(db.scalar(stmt))


def record(db: Session, p: Principal, body: TxnIn, *, commit: bool = True) -> tuple[InventoryTransaction, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, InventoryTransaction, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True
    j = get_journey(db, p, body.journey_id, for_update=True)  # serialises balance checks per journey
    p.require("inventory.transact", j.division_id)
    if not (j.supervisor_id == p.id or is_allocated(db, j.id, p.id) or p.has("journeys.manage", j.division_id)):
        raise Forbidden("Only journey staff or journey managers may record inventory", code="not_journey_staff")
    state = journey_state(j)
    if state == JourneyState.CANCELLED:
        raise BusinessRuleViolation("Journey is cancelled", code="journey_cancelled")
    if state == JourneyState.HISTORY:
        if body.txn_type == InventoryTxnType.ISSUE or today_ist() > j.end_date + timedelta(days=get_policy(db, j.division_id).attendance_late_grace_days):
            raise BusinessRuleViolation("Journey has ended", code="journey_closed")
    item = db.get(InventoryItem, body.item_id)
    if item is None or item.division_id != j.division_id or not item.is_active:
        raise BusinessRuleViolation("Item not found or inactive in this division")
    if body.coach_code and body.coach_code not in {c.code for c in j.coaches}:
        raise BusinessRuleViolation("Coach is not part of this journey", code="unknown_coach")
    if body.txn_type == InventoryTxnType.RETURN:
        outstanding = _outstanding(db, j.id, item.id, body.coach_code)
        if body.quantity > outstanding + 1e-9:
            raise BusinessRuleViolation("Return exceeds the quantity issued", code="return_exceeds_issue",
                                        details={"outstanding": outstanding})
    txn = InventoryTransaction(**body.model_dump(), division_id=j.division_id, created_by_id=p.id, payload_hash=digest)
    db.add(txn)
    db.flush()
    audit(db, actor_id=p.id, action=f"inventory.{body.txn_type.value}", entity=txn, division_id=j.division_id,
          changes={"item_id": item.id, "quantity": body.quantity, "coach": body.coach_code})
    if commit:
        db.commit()
    return txn, False


def ledger(db: Session, p: Principal, params: PageParams, journey_id: uuid.UUID):
    j = get_journey(db, p, journey_id)
    p.require("inventory.read", j.division_id)
    stmt = select(InventoryTransaction).where(InventoryTransaction.journey_id == j.id)
    return paginate(db, stmt.order_by(InventoryTransaction.created_at, InventoryTransaction.id), params)


def balance(db: Session, p: Principal, journey_id: uuid.UUID) -> list[dict]:
    j = get_journey(db, p, journey_id)
    p.require("inventory.read", j.division_id)
    issued = func.sum(case((InventoryTransaction.txn_type == InventoryTxnType.ISSUE, InventoryTransaction.quantity), else_=0))
    returned = func.sum(case((InventoryTransaction.txn_type == InventoryTxnType.RETURN, InventoryTransaction.quantity), else_=0))
    rows = db.execute(
        select(InventoryItem.id, InventoryItem.name, InventoryItem.unit, InventoryItem.ideal_qty, InventoryTransaction.coach_code,
               issued, returned)
        .join(InventoryItem, InventoryItem.id == InventoryTransaction.item_id)
        .where(InventoryTransaction.journey_id == j.id)
        .group_by(InventoryItem.id, InventoryItem.name, InventoryItem.unit, InventoryItem.ideal_qty, InventoryTransaction.coach_code)
        .order_by(InventoryItem.name, InventoryTransaction.coach_code.nulls_first())
    ).all()
    return [dict(item_id=r[0], item_name=r[1], unit=r[2], ideal_qty=float(r[3]), coach_code=r[4], issued=float(r[5]),
                 returned=float(r[6]), consumed=float(r[5]) - float(r[6])) for r in rows]
