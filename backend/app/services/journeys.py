import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import and_, case, exists, or_, select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, Conflict, NotFound
from app.models import (
    Inspection,
    Journey,
    JourneyCoach,
    JourneyState,
    JourneyStatus,
    RoleId,
    StaffAllocation,
    Train,
    User,
    UserStatus,
)
from app.schemas.common import PageParams
from app.schemas.journeys import JourneyCancel, JourneyCreate, JourneyUpdate, StaffAdd, SupervisorAssign
from app.schemas.trains import CoachIn
from app.security.principal import Principal
from app.services.common import audit, commit_or_conflict, diff, paginate
from app.timeutil import to_ist_date, today_ist, utcnow

ALLOCATABLE_ROLES = {RoleId.SUPERVISOR, RoleId.JANITOR}


# ---- pure rules --------------------------------------------------------------------------------------------


def derive_dates(journey_date: date, duration_days: int) -> tuple[date, date]:
    """linked = start + duration; end = linked + duration - 1 (a zero-day train ends on the linked date)."""
    linked = journey_date + timedelta(days=duration_days)
    end = linked + timedelta(days=max(duration_days - 1, 0))
    return linked, end


def journey_state(j: Journey, today: date | None = None) -> JourneyState:
    if j.status == JourneyStatus.CANCELLED:
        return JourneyState.CANCELLED
    today = today or today_ist()
    if today < j.journey_date:
        return JourneyState.SCHEDULED
    if today > j.end_date:
        return JourneyState.HISTORY
    return JourneyState.ACTIVE


def state_clause(state: JourneyState, today: date):
    live = Journey.status == JourneyStatus.PLANNED
    return {
        JourneyState.CANCELLED: Journey.status == JourneyStatus.CANCELLED,
        JourneyState.SCHEDULED: and_(live, Journey.journey_date > today),
        JourneyState.HISTORY: and_(live, Journey.end_date < today),
        JourneyState.ACTIVE: and_(live, Journey.journey_date <= today, Journey.end_date >= today),
    }[state]


def day_date(j: Journey, day: int) -> date:
    return j.journey_date + timedelta(days=day - 1)


def journey_day_for(j: Journey, on: date) -> int:
    return (on - j.journey_date).days + 1


# ---- access ------------------------------------------------------------------------------------------------


def _involved(p: Principal):
    return or_(
        Journey.supervisor_id == p.id,
        exists().where(StaffAllocation.journey_id == Journey.id, StaffAllocation.user_id == p.id,
                       StaffAllocation.removed_at.is_(None)),
    )


def can_see(db: Session, p: Principal, j: Journey) -> bool:
    if p.has("journeys.read_all", j.division_id):
        return True
    if not p.has("journeys.read", j.division_id):
        return False
    return j.supervisor_id == p.id or is_allocated(db, j.id, p.id)


def is_allocated(db: Session, journey_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return db.scalar(select(StaffAllocation.id).where(
        StaffAllocation.journey_id == journey_id, StaffAllocation.user_id == user_id, StaffAllocation.removed_at.is_(None))) is not None


def get_journey(db: Session, p: Principal, journey_id: uuid.UUID, *, for_update: bool = False) -> Journey:
    stmt = select(Journey).where(Journey.id == journey_id)
    if for_update:
        stmt = stmt.with_for_update(of=Journey)
    j = db.scalars(stmt).unique().one_or_none()
    if j is None or not p.can_access_division(j.division_id) or not can_see(db, p, j):
        raise NotFound("Journey not found")
    return j


def require_open(j: Journey, *, allow_active: bool = True) -> None:
    state = journey_state(j)
    if state == JourneyState.CANCELLED:
        raise BusinessRuleViolation("Journey is cancelled", code="journey_cancelled")
    if state == JourneyState.HISTORY:
        raise BusinessRuleViolation("Journey has ended", code="journey_closed")
    if state == JourneyState.ACTIVE and not allow_active:
        raise BusinessRuleViolation("Journey already started", code="journey_started")


MAX_CLOCK_SKEW = timedelta(minutes=10)


def check_capture_window(j: Journey, device_ts: datetime, grace_days: int) -> date:
    """A captured record must be taken during the journey and reach the server within the grace period.
    Returns the IST date of capture."""
    if j.status == JourneyStatus.CANCELLED:
        raise BusinessRuleViolation("Journey is cancelled", code="journey_cancelled")
    now = utcnow()
    if device_ts > now + MAX_CLOCK_SKEW:
        raise BusinessRuleViolation("Device timestamp is in the future", code="clock_skew")
    captured_on = to_ist_date(device_ts)
    if not (j.journey_date <= captured_on <= j.end_date):
        raise BusinessRuleViolation("Record was not captured during the journey", code="outside_journey")
    if today_ist(now) > j.end_date + timedelta(days=grace_days):
        raise BusinessRuleViolation("Journey closed for late submissions", code="journey_closed")
    return captured_on


# ---- validation helpers ------------------------------------------------------------------------------------


def _train(db: Session, train_id: uuid.UUID, division_id: uuid.UUID, label: str) -> Train:
    train = db.get(Train, train_id)
    if train is None or train.division_id != division_id:
        raise BusinessRuleViolation(f"{label} not found in this division")
    if not train.is_active:
        raise BusinessRuleViolation(f"{label} is inactive")
    return train


def _staff_user(db: Session, user_id: uuid.UUID, division_id: uuid.UUID, roles: set[RoleId], label: str) -> User:
    user = db.get(User, user_id)
    if user is None or user.division_id != division_id or user.status != UserStatus.ACTIVE:
        raise BusinessRuleViolation(f"{label} must be an active user of this division", details={"user_id": str(user_id)})
    if RoleId(user.role_id) not in roles:
        raise BusinessRuleViolation(f"{label} has a role that cannot be assigned", details={"user_id": str(user_id)})
    return user


def _coach_rows(coaches: list[CoachIn]) -> list[JourneyCoach]:
    return [JourneyCoach(code=c.code, classification=c.classification, position=i) for i, c in enumerate(coaches, 1)]


def _check_dates(journey_date: date, outbound_end: date | None, linked: date, end: date) -> None:
    if linked < journey_date:
        raise BusinessRuleViolation("Linked journey date cannot be before the journey date")
    if end < linked:
        raise BusinessRuleViolation("End date cannot be before the linked journey date")
    if outbound_end is not None and not (journey_date <= outbound_end <= end):
        raise BusinessRuleViolation("Outbound end date must fall within the journey")


def _allocate(db: Session, j: Journey, user: User, actor_id: uuid.UUID) -> StaffAllocation | None:
    if is_allocated(db, j.id, user.id):
        return None
    alloc = StaffAllocation(journey_id=j.id, user_id=user.id, role_id=user.role_id, division_id=j.division_id,
                            allocated_by_id=actor_id)
    db.add(alloc)
    return alloc


# ---- commands ----------------------------------------------------------------------------------------------


def create_journey(db: Session, p: Principal, body: JourneyCreate) -> Journey:
    p.require("journeys.manage", body.division_id)
    train = _train(db, body.train_id, body.division_id, "Train")
    if body.linked_train_id is not None:
        if body.linked_train_id == body.train_id:
            raise BusinessRuleViolation("Linked train must differ from the main train")
        _train(db, body.linked_train_id, body.division_id, "Linked train")
    supervisor = _staff_user(db, body.supervisor_id, body.division_id, {RoleId.SUPERVISOR}, "Supervisor")
    staff = [_staff_user(db, uid, body.division_id, ALLOCATABLE_ROLES, "Staff member") for uid in dict.fromkeys(body.staff_ids)]
    if body.journey_date < today_ist() - timedelta(days=1):
        raise BusinessRuleViolation("Journey date is in the past")

    linked, end = derive_dates(body.journey_date, train.duration_days)
    if body.linked_journey_date is not None:
        linked = body.linked_journey_date
        end = linked + timedelta(days=max(train.duration_days - 1, 0))
    if body.end_date is not None:
        end = body.end_date
    _check_dates(body.journey_date, body.outbound_end_date, linked, end)
    coaches = body.coaches or [CoachIn(code=c.code, classification=c.classification) for c in train.coaches]

    j = Journey(
        division_id=body.division_id, train_id=train.id, linked_train_id=body.linked_train_id,
        journey_date=body.journey_date, outbound_end_date=body.outbound_end_date, linked_journey_date=linked, end_date=end,
        start_time=body.start_time or train.start_time, end_time=body.end_time or train.end_time,
        return_start_time=body.return_start_time or train.return_start_time,
        return_end_time=body.return_end_time or train.return_end_time,
        duration_days=train.duration_days, operational_days=train.operational_days, daywise=train.daywise,
        inspection_rounds_per_day=train.inspection_rounds_per_day,
        before_inspection_enabled=train.before_inspection_enabled, after_inspection_enabled=train.after_inspection_enabled,
        supervisor_id=supervisor.id, created_by_id=p.id, status=JourneyStatus.PLANNED, coaches=_coach_rows(coaches),
    )
    db.add(j)
    db.flush()
    for user in [supervisor, *staff]:
        _allocate(db, j, user, p.id)
    audit(db, actor_id=p.id, action="journey.create", entity=j, division_id=j.division_id,
          changes={**body.model_dump(mode="json"), "linked_journey_date": str(linked), "end_date": str(end)})
    commit_or_conflict(db, "Duplicate journey data")
    return j


def update_journey(db: Session, p: Principal, journey_id: uuid.UUID, body: JourneyUpdate) -> Journey:
    j = get_journey(db, p, journey_id, for_update=True)
    p.require("journeys.manage", j.division_id)
    _check_version(j, body.version)
    require_open(j)
    started = journey_state(j) == JourneyState.ACTIVE
    updates = body.model_dump(exclude_unset=True, exclude={"version", "coaches"})
    if started and "journey_date" in updates and updates["journey_date"] != j.journey_date:
        raise BusinessRuleViolation("Cannot move the start date of a journey in progress", code="journey_started")
    if "linked_train_id" in updates and updates["linked_train_id"] is not None:
        if updates["linked_train_id"] == j.train_id:
            raise BusinessRuleViolation("Linked train must differ from the main train")
        _train(db, updates["linked_train_id"], j.division_id, "Linked train")
    if "journey_date" in updates and not {"linked_journey_date", "end_date"} & updates.keys():
        updates["linked_journey_date"], updates["end_date"] = derive_dates(updates["journey_date"], j.duration_days)
    _check_dates(updates.get("journey_date", j.journey_date), updates.get("outbound_end_date", j.outbound_end_date),
                 updates.get("linked_journey_date", j.linked_journey_date), updates.get("end_date", j.end_date))
    changes = diff(j, updates)
    if body.coaches is not None:
        new_codes = {c.code for c in body.coaches}
        used = set(db.scalars(select(Inspection.coach_code).where(Inspection.journey_id == j.id).distinct()))
        if used - new_codes:
            raise BusinessRuleViolation("Cannot remove coaches that already have inspections", details=sorted(used - new_codes))
        changes["coaches"] = {"from": [c.code for c in j.coaches], "to": [c.code for c in body.coaches]}
        j.coaches.clear()
        db.flush()
        j.coaches.extend(_coach_rows(body.coaches))
    for k, v in updates.items():
        setattr(j, k, v)
    audit(db, actor_id=p.id, action="journey.update", entity=j, division_id=j.division_id, changes=changes)
    db.commit()
    db.refresh(j)
    return j


def assign_supervisor(db: Session, p: Principal, journey_id: uuid.UUID, body: SupervisorAssign) -> Journey:
    j = get_journey(db, p, journey_id, for_update=True)
    p.require("journeys.manage", j.division_id)
    _check_version(j, body.version)
    require_open(j)
    sup = _staff_user(db, body.supervisor_id, j.division_id, {RoleId.SUPERVISOR}, "Supervisor")
    audit(db, actor_id=p.id, action="journey.supervisor.assign", entity=j, division_id=j.division_id,
          changes={"supervisor_id": {"from": j.supervisor_id, "to": sup.id}})
    j.supervisor_id = sup.id
    _allocate(db, j, sup, p.id)
    db.commit()
    return j


def cancel_journey(db: Session, p: Principal, journey_id: uuid.UUID, body: JourneyCancel) -> Journey:
    j = get_journey(db, p, journey_id, for_update=True)
    p.require("journeys.manage", j.division_id)
    _check_version(j, body.version)
    require_open(j)
    j.status = JourneyStatus.CANCELLED
    j.cancelled_at = utcnow()
    j.cancelled_by_id = p.id
    j.cancel_reason = body.reason
    audit(db, actor_id=p.id, action="journey.cancel", entity=j, division_id=j.division_id, changes={"reason": body.reason})
    db.commit()
    return j


def add_staff(db: Session, p: Principal, journey_id: uuid.UUID, body: StaffAdd) -> list[StaffAllocation]:
    j = get_journey(db, p, journey_id, for_update=True)
    p.require("staff.manage", j.division_id)
    require_open(j)
    added = []
    for uid in dict.fromkeys(body.user_ids):
        user = _staff_user(db, uid, j.division_id, ALLOCATABLE_ROLES, "Staff member")
        if (alloc := _allocate(db, j, user, p.id)) is not None:
            added.append(alloc)
    db.flush()
    audit(db, actor_id=p.id, action="journey.staff.add", entity=j, division_id=j.division_id,
          changes={"user_ids": [str(a.user_id) for a in added]})
    commit_or_conflict(db, "Staff member already allocated")
    return list_staff(db, p, journey_id)


def remove_staff(db: Session, p: Principal, journey_id: uuid.UUID, user_id: uuid.UUID) -> None:
    j = get_journey(db, p, journey_id, for_update=True)
    p.require("staff.manage", j.division_id)
    require_open(j)
    if user_id == j.supervisor_id:
        raise BusinessRuleViolation("Assign a different supervisor before removing the current one")
    alloc = db.scalar(select(StaffAllocation).where(
        StaffAllocation.journey_id == j.id, StaffAllocation.user_id == user_id, StaffAllocation.removed_at.is_(None)))
    if alloc is None:
        raise NotFound("Staff member is not allocated")
    alloc.removed_at = utcnow()
    alloc.removed_by_id = p.id
    audit(db, actor_id=p.id, action="journey.staff.remove", entity=j, division_id=j.division_id, changes={"user_id": str(user_id)})
    db.commit()


def list_staff(db: Session, p: Principal, journey_id: uuid.UUID, include_removed: bool = False) -> list[dict]:
    j = get_journey(db, p, journey_id)
    stmt = select(StaffAllocation).where(StaffAllocation.journey_id == j.id)
    if not include_removed:
        stmt = stmt.where(StaffAllocation.removed_at.is_(None))
    rows = db.scalars(stmt.order_by(StaffAllocation.role_id, StaffAllocation.created_at)).unique().all()
    return [dict(id=a.id, user_id=a.user_id, role_id=a.role_id, name=a.user.name, emp_id=a.user.emp_id,
                 allocated_at=a.created_at, removed_at=a.removed_at) for a in rows]


def list_journeys(db: Session, p: Principal, params: PageParams, *, state: JourneyState | None,
                  division_id: uuid.UUID | None, train_id: uuid.UUID | None, supervisor_id: uuid.UUID | None,
                  date_from: date | None, date_to: date | None, mine: bool, updated_since: datetime | None):
    divisions = p.require_any_division("journeys.read")
    if division_id is not None:
        divisions = [d for d in divisions if d == division_id]
    all_divs = [] if mine else [d for d in divisions if p.has("journeys.read_all", d)]
    scope = and_(Journey.division_id.in_(divisions), _involved(p))
    if all_divs:
        scope = or_(Journey.division_id.in_(all_divs), scope)
    stmt = select(Journey).options(selectinload(Journey.coaches)).where(scope)
    if state:
        stmt = stmt.where(state_clause(state, today_ist()))
    if train_id:
        stmt = stmt.where(or_(Journey.train_id == train_id, Journey.linked_train_id == train_id))
    if supervisor_id:
        stmt = stmt.where(Journey.supervisor_id == supervisor_id)
    if date_from:
        stmt = stmt.where(Journey.end_date >= date_from)
    if date_to:
        stmt = stmt.where(Journey.journey_date <= date_to)
    if updated_since:
        stmt = stmt.where(Journey.updated_at > updated_since)
    order = case((Journey.status == JourneyStatus.CANCELLED, 1), else_=0)
    return paginate(db, stmt.order_by(order, Journey.journey_date.desc(), Journey.id), params)


def _check_version(j: Journey, version: int) -> None:
    if j.version != version:
        raise Conflict("Journey was modified by someone else; reload and retry", code="version_conflict",
                       details={"current_version": j.version})


def to_out(j: Journey) -> dict:
    return dict(
        id=j.id, division_id=j.division_id, train_id=j.train_id, train_no=j.train.train_no, train_name=j.train.name,
        linked_train_id=j.linked_train_id, linked_train_no=j.linked_train.train_no if j.linked_train else None,
        journey_date=j.journey_date, outbound_end_date=j.outbound_end_date, linked_journey_date=j.linked_journey_date,
        end_date=j.end_date, start_time=j.start_time, end_time=j.end_time, return_start_time=j.return_start_time,
        return_end_time=j.return_end_time, duration_days=j.duration_days, operational_days=j.operational_days,
        daywise=j.daywise, inspection_rounds_per_day=j.inspection_rounds_per_day,
        before_inspection_enabled=j.before_inspection_enabled, after_inspection_enabled=j.after_inspection_enabled,
        supervisor_id=j.supervisor_id, supervisor_name=j.supervisor.name, created_by_id=j.created_by_id,
        state=journey_state(j), cancel_reason=j.cancel_reason, cancelled_at=j.cancelled_at, version=j.version,
        coaches=j.coaches, updated_at=j.updated_at,
    )
