import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, NotFound
from app.models import Division, Train, TrainCoach
from app.schemas.common import PageParams
from app.schemas.trains import CoachesReplace, CoachIn, TrainCreate, TrainUpdate
from app.security.principal import Principal
from app.services.common import audit, commit_or_conflict, diff, flush_or_conflict, paginate


def _coach_rows(coaches: list[CoachIn]) -> list[TrainCoach]:
    return [TrainCoach(code=c.code, classification=c.classification, position=i) for i, c in enumerate(coaches, 1)]


def get_train(db: Session, p: Principal, train_id: uuid.UUID, permission: str = "trains.read") -> Train:
    train = db.get(Train, train_id)
    if train is None or not p.can_access_division(train.division_id):
        raise NotFound("Train not found")
    p.require(permission, train.division_id)
    return train


def create_train(db: Session, p: Principal, body: TrainCreate) -> Train:
    p.require("trains.manage", body.division_id)
    division = db.get(Division, body.division_id)
    if division is None or not division.is_active:
        raise BusinessRuleViolation("Division is not active")
    train = Train(**body.model_dump(exclude={"coaches"}), coaches=_coach_rows(body.coaches))
    db.add(train)
    flush_or_conflict(db, "Train number already exists in this division")
    audit(db, actor_id=p.id, action="train.create", entity=train, division_id=train.division_id, changes=body.model_dump(mode="json"))
    commit_or_conflict(db, "Train number already exists in this division")
    return train


def update_train(db: Session, p: Principal, train_id: uuid.UUID, body: TrainUpdate) -> Train:
    train = get_train(db, p, train_id, "trains.manage")
    updates = body.model_dump(exclude_unset=True)
    before = updates.get("before_inspection_enabled", train.before_inspection_enabled)
    after = updates.get("after_inspection_enabled", train.after_inspection_enabled)
    if not (before or after):
        raise BusinessRuleViolation("At least one inspection phase must be enabled")
    audit(db, actor_id=p.id, action="train.update", entity=train, division_id=train.division_id, changes=diff(train, updates))
    for k, v in updates.items():
        setattr(train, k, v)
    db.commit()
    return train


def replace_coaches(db: Session, p: Principal, train_id: uuid.UUID, body: CoachesReplace) -> Train:
    """Existing journeys keep their own coach snapshot; only future journeys see the new list."""
    train = get_train(db, p, train_id, "trains.manage")
    old = [(c.code, c.classification.value) for c in train.coaches]
    train.coaches.clear()
    db.flush()
    train.coaches.extend(_coach_rows(body.coaches))
    audit(db, actor_id=p.id, action="train.coaches.replace", entity=train, division_id=train.division_id,
          changes={"from": old, "to": [(c.code, c.classification.value) for c in body.coaches]})
    db.commit()
    db.refresh(train)
    return train


def list_trains(db: Session, p: Principal, params: PageParams, *, division_id: uuid.UUID | None, active: bool | None,
                q: str | None, updated_since=None) -> tuple[list[Train], int]:
    divisions = p.require_any_division("trains.read")
    if division_id is not None:
        divisions = [d for d in divisions if d == division_id]
    stmt = select(Train).options(selectinload(Train.coaches)).where(Train.division_id.in_(divisions))
    if active is not None:
        stmt = stmt.where(Train.is_active.is_(active))
    if q:
        stmt = stmt.where(Train.train_no.ilike(f"%{q}%") | Train.name.ilike(f"%{q}%"))
    if updated_since is not None:
        stmt = stmt.where(Train.updated_at > updated_since)
    return paginate(db, stmt.order_by(Train.train_no, Train.id), params)
