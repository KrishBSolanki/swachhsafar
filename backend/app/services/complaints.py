import uuid
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.sqlcompat import insert_for
from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import (
    Complaint,
    ComplaintAttachment,
    ComplaintCategory,
    ComplaintCounter,
    ComplaintDepartment,
    ComplaintHistory,
    ComplaintStatus,
    Division,
    MediaKind,
    PermissionEffect,
    RolePermission,
    User,
    UserStatus,
)
from app.schemas.common import PageParams
from app.schemas.complaints import CategoryIn, CategoryUpdate, ComplaintIn, DepartmentIn, DepartmentUpdate, TransitionIn
from app.security.principal import Principal
from app.services import media
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
from app.services.journeys import get_journey
from app.services.policy import get_policy
from app.timeutil import IST, utcnow

TRANSITIONS: dict[ComplaintStatus, set[ComplaintStatus]] = {
    ComplaintStatus.CREATED: {ComplaintStatus.IN_PROCESS, ComplaintStatus.FORWARDED, ComplaintStatus.COMPLETED},
    ComplaintStatus.IN_PROCESS: {ComplaintStatus.FORWARDED, ComplaintStatus.COMPLETED},
    ComplaintStatus.FORWARDED: {ComplaintStatus.IN_PROCESS, ComplaintStatus.FORWARDED, ComplaintStatus.COMPLETED},
    ComplaintStatus.COMPLETED: set(),
}

# ---- masters -----------------------------------------------------------------------------------------------


def create_department(db: Session, p: Principal, body: DepartmentIn) -> ComplaintDepartment:
    p.require("complaints.masters.manage", body.division_id)
    dep = ComplaintDepartment(**body.model_dump())
    db.add(dep)
    flush_or_conflict(db, "Department already exists")
    audit(db, actor_id=p.id, action="complaint_department.create", entity=dep, division_id=dep.division_id, changes=body.model_dump())
    commit_or_conflict(db, "Department already exists")
    return dep


def update_department(db: Session, p: Principal, dep_id: uuid.UUID, body: DepartmentUpdate) -> ComplaintDepartment:
    dep = get_or_404(db, ComplaintDepartment, dep_id, "Department")
    p.require("complaints.masters.manage", dep.division_id)
    updates = body.model_dump(exclude_unset=True)
    audit(db, actor_id=p.id, action="complaint_department.update", entity=dep, division_id=dep.division_id, changes=diff(dep, updates))
    for k, v in updates.items():
        setattr(dep, k, v)
    commit_or_conflict(db, "Department already exists")
    return dep


def _department(db: Session, dep_id: uuid.UUID | None, division_id: uuid.UUID) -> ComplaintDepartment | None:
    if dep_id is None:
        return None
    dep = db.get(ComplaintDepartment, dep_id)
    if dep is None or dep.division_id != division_id or not dep.is_active:
        raise BusinessRuleViolation("Department not found or inactive in this division")
    return dep


def create_category(db: Session, p: Principal, body: CategoryIn) -> ComplaintCategory:
    p.require("complaints.masters.manage", body.division_id)
    if body.parent_id is not None:
        parent = db.get(ComplaintCategory, body.parent_id)
        if parent is None or parent.division_id != body.division_id or parent.parent_id is not None:
            raise BusinessRuleViolation("Parent must be a main category of the same division")
    _department(db, body.default_department_id, body.division_id)
    cat = ComplaintCategory(**body.model_dump())
    db.add(cat)
    flush_or_conflict(db, "Category already exists")
    audit(db, actor_id=p.id, action="complaint_category.create", entity=cat, division_id=cat.division_id, changes=body.model_dump(mode="json"))
    commit_or_conflict(db, "Category already exists")
    return cat


def update_category(db: Session, p: Principal, cat_id: uuid.UUID, body: CategoryUpdate) -> ComplaintCategory:
    cat = get_or_404(db, ComplaintCategory, cat_id, "Category")
    p.require("complaints.masters.manage", cat.division_id)
    updates = body.model_dump(exclude_unset=True)
    if "default_department_id" in updates:
        _department(db, updates["default_department_id"], cat.division_id)
    audit(db, actor_id=p.id, action="complaint_category.update", entity=cat, division_id=cat.division_id, changes=diff(cat, updates))
    for k, v in updates.items():
        setattr(cat, k, v)
    commit_or_conflict(db, "Category already exists")
    return cat


def list_departments(db: Session, p: Principal, division_id: uuid.UUID) -> list[ComplaintDepartment]:
    if not p.can_access_division(division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    return list(db.scalars(select(ComplaintDepartment).where(ComplaintDepartment.division_id == division_id).order_by(ComplaintDepartment.name)))


def list_categories(db: Session, p: Principal, division_id: uuid.UUID) -> list[ComplaintCategory]:
    if not p.can_access_division(division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    return list(db.scalars(select(ComplaintCategory).where(ComplaintCategory.division_id == division_id)
                           .order_by(ComplaintCategory.parent_id.nulls_first(), ComplaintCategory.sort_order, ComplaintCategory.name)))


# ---- complaints --------------------------------------------------------------------------------------------


def _next_number(db: Session, division: Division) -> str:
    year = utcnow().astimezone(IST).year
    stmt = (insert_for(db)(ComplaintCounter).values(division_id=division.id, year=year, last_seq=1)
            .on_conflict_do_update(index_elements=["division_id", "year"], set_={"last_seq": ComplaintCounter.last_seq + 1})
            .returning(ComplaintCounter.last_seq))
    seq = db.execute(stmt).scalar_one()
    return f"{division.code}-{year}-{seq:06d}"


def create(db: Session, p: Principal, body: ComplaintIn, *, commit: bool = True) -> tuple[Complaint, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, Complaint, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True
    division = get_or_404(db, Division, body.division_id, "Division")
    p.require("complaints.create", division.id)
    train_id = coach_class = None
    if body.journey_id is not None:
        j = get_journey(db, p, body.journey_id)
        if j.division_id != division.id:
            raise BusinessRuleViolation("Journey belongs to another division")
        train_id = j.train_id
        if body.coach_code:
            coach = next((c for c in j.coaches if c.code == body.coach_code), None)
            if coach is None:
                raise BusinessRuleViolation("Coach is not part of this journey", code="unknown_coach")
            coach_class = coach.classification
    elif body.coach_code:
        raise BusinessRuleViolation("A coach can only be given together with a journey")

    cat = db.get(ComplaintCategory, body.category_id)
    if cat is None or cat.division_id != division.id or cat.parent_id is not None or not cat.is_active:
        raise BusinessRuleViolation("Main category not found or inactive", code="invalid_category")
    sub = None
    if body.subcategory_id is not None:
        sub = db.get(ComplaintCategory, body.subcategory_id)
        if sub is None or sub.parent_id != cat.id or not sub.is_active:
            raise BusinessRuleViolation("Sub-category does not belong to the main category", code="invalid_category")
    elif db.scalar(select(ComplaintCategory.id).where(ComplaintCategory.parent_id == cat.id, ComplaintCategory.is_active.is_(True))):
        raise BusinessRuleViolation("Choose a sub-category", code="subcategory_required")

    sla = (sub and sub.sla_hours) or cat.sla_hours or get_policy(db, division.id).complaint_default_sla_hours
    department_id = (sub and sub.default_department_id) or cat.default_department_id
    for media_id in body.attachment_ids:
        media.claim(db, media_id, MediaKind.COMPLAINT_ATTACHMENT, division.id, p.id, required=True, label="Attachment")
    now = utcnow()
    complaint = Complaint(
        id=body.id, complaint_no=_next_number(db, division), division_id=division.id, journey_id=body.journey_id,
        train_id=train_id, coach_code=body.coach_code, coach_class=coach_class, category_id=cat.id,
        subcategory_id=sub.id if sub else None, description=body.description, latitude=body.latitude,
        longitude=body.longitude, department_id=department_id, status=ComplaintStatus.CREATED, sla_hours=sla,
        due_at=now + timedelta(hours=sla), device_timestamp=body.device_timestamp, created_by_id=p.id, payload_hash=digest,
        attachments=[ComplaintAttachment(media_id=m) for m in body.attachment_ids],
    )
    db.add(complaint)
    db.add(ComplaintHistory(complaint_id=complaint.id, from_status=None, to_status=ComplaintStatus.CREATED, actor_id=p.id,
                            department_id=department_id, remarks="Created"))
    try:
        db.flush()
    except IntegrityError as exc:
        raise Conflict("Attachment already used by another complaint", code="duplicate_attachment") from exc
    audit(db, actor_id=p.id, action="complaint.create", entity=complaint, division_id=division.id,
          changes={"complaint_no": complaint.complaint_no, "sla_hours": sla})
    if commit:
        db.commit()
    return complaint, False


def _can_receive(db: Session, user: User, division_id: uuid.UUID) -> bool:
    rows = db.execute(select(RolePermission.division_id, RolePermission.effect).where(
        RolePermission.role_id == user.role_id, RolePermission.permission_code == "complaints.manage",
        or_(RolePermission.division_id.is_(None), RolePermission.division_id == division_id))).all()
    override = next((e for d, e in rows if d is not None), None)
    effect = override or next((e for d, e in rows if d is None), None)
    return effect == PermissionEffect.ALLOW


def transition(db: Session, p: Principal, complaint_id: uuid.UUID, body: TransitionIn) -> Complaint:
    c = db.scalar(select(Complaint).where(Complaint.id == complaint_id).with_for_update())
    if c is None or not p.can_access_division(c.division_id):
        raise NotFound("Complaint not found")
    if not (p.has("complaints.manage", c.division_id) or c.assigned_to_id == p.id):
        raise Forbidden("Not allowed to process this complaint", code="permission_denied")
    if body.to_status not in TRANSITIONS[c.status]:
        raise BusinessRuleViolation(f"Cannot move a {c.status.value} complaint to {body.to_status.value}", code="invalid_transition")

    department = _department(db, body.department_id, c.division_id)
    forward_to = None
    if body.to_status == ComplaintStatus.FORWARDED:
        if body.forward_to_user_id is None:
            raise BusinessRuleViolation("Forwarding requires forward_to_user_id")
        forward_to = db.get(User, body.forward_to_user_id)
        if (forward_to is None or forward_to.division_id != c.division_id or forward_to.status != UserStatus.ACTIVE
                or not _can_receive(db, forward_to, c.division_id)):
            raise BusinessRuleViolation("Complaint can only be forwarded to an active complaint handler of this division")
        c.assigned_to_id = forward_to.id
    elif body.forward_to_user_id is not None:
        raise BusinessRuleViolation("forward_to_user_id is only valid when forwarding")
    if body.to_status == ComplaintStatus.COMPLETED:
        if not body.remarks:
            raise BusinessRuleViolation("Resolution remarks are required to close a complaint")
        c.resolution_remarks = body.remarks
        c.closed_at = utcnow()
        c.closed_by_id = p.id
    if department is not None:
        c.department_id = department.id

    db.add(ComplaintHistory(complaint_id=c.id, from_status=c.status, to_status=body.to_status, actor_id=p.id,
                            forwarded_to_id=forward_to.id if forward_to else None,
                            department_id=department.id if department else None, remarks=body.remarks))
    audit(db, actor_id=p.id, action="complaint.transition", entity=c, division_id=c.division_id,
          changes={"from": c.status, "to": body.to_status, "forward_to": body.forward_to_user_id})
    c.status = body.to_status
    db.commit()
    return get(db, p, c.id)


def get(db: Session, p: Principal, complaint_id: uuid.UUID) -> Complaint:
    c = db.scalar(select(Complaint).options(selectinload(Complaint.history), selectinload(Complaint.attachments))
                  .where(Complaint.id == complaint_id))
    if c is None or not p.can_access_division(c.division_id):
        raise NotFound("Complaint not found")
    if not (p.has("complaints.read", c.division_id) or c.created_by_id == p.id or c.assigned_to_id == p.id):
        raise NotFound("Complaint not found")
    return c


def list_records(db: Session, p: Principal, params: PageParams, *, status, overdue, journey_id, category_id,
                 assigned_to_me: bool, division_id):
    readable = [d for d in p.scope_divisions() if p.has("complaints.read", d)]
    stmt = select(Complaint).options(selectinload(Complaint.history), selectinload(Complaint.attachments)).where(
        or_(Complaint.division_id.in_(readable), Complaint.created_by_id == p.id, Complaint.assigned_to_id == p.id))
    if division_id:
        stmt = stmt.where(Complaint.division_id == division_id)
    for col, val in ((Complaint.status, status), (Complaint.journey_id, journey_id), (Complaint.category_id, category_id)):
        if val is not None:
            stmt = stmt.where(col == val)
    if assigned_to_me:
        stmt = stmt.where(Complaint.assigned_to_id == p.id)
    if overdue is not None:
        cond = (Complaint.status != ComplaintStatus.COMPLETED) & (Complaint.due_at < utcnow())
        stmt = stmt.where(cond if overdue else ~cond)
    return paginate(db, stmt.order_by(Complaint.server_timestamp.desc(), Complaint.id), params)
