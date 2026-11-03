import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import ChargeMap, Division, EmployeeKyc, Permission, Role, RoleId, RolePermission, User, UserStatus
from app.schemas.common import PageParams
from app.schemas.org import ChargeMapCreate, DivisionCreate, DivisionUpdate, GrantIn, KycIn, UserCreate, UserUpdate
from app.security.catalog import CHARGE_ELIGIBLE_ROLES
from app.security.principal import Principal
from app.services.common import audit, commit_or_conflict, diff, flush_or_conflict, get_or_404, paginate
from app.timeutil import utcnow

# ---- divisions ---------------------------------------------------------------------------------------------


def create_division(db: Session, p: Principal, body: DivisionCreate) -> Division:
    if not p.is_super_admin:
        raise Forbidden("Only Super Admin can create divisions", code="permission_denied")
    division = Division(code=body.code, name=body.name)
    db.add(division)
    flush_or_conflict(db, "Division code already exists")
    audit(db, actor_id=p.id, action="division.create", entity=division, division_id=division.id, changes=body.model_dump())
    commit_or_conflict(db, "Division code already exists")
    return division


def update_division(db: Session, p: Principal, division_id: uuid.UUID, body: DivisionUpdate) -> Division:
    division = get_or_404(db, Division, division_id, "Division")
    p.require("divisions.manage", division_id)
    updates = body.model_dump(exclude_unset=True)
    audit(db, actor_id=p.id, action="division.update", entity=division, division_id=division_id, changes=diff(division, updates))
    for k, v in updates.items():
        setattr(division, k, v)
    db.commit()
    return division


def list_divisions(db: Session, p: Principal) -> list[Division]:
    return list(db.scalars(select(Division).where(Division.id.in_(p.scope_divisions())).order_by(Division.name)))


# ---- permissions -------------------------------------------------------------------------------------------


def upsert_grant(db: Session, p: Principal, body: GrantIn) -> RolePermission:
    if body.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can change global grants", code="permission_denied")
    else:
        p.require("permissions.manage", body.division_id)
    if body.role_id == RoleId.SUPER_ADMIN:
        raise BusinessRuleViolation("Super Admin grants are fixed")
    if db.get(Permission, body.permission_code) is None:
        raise NotFound("Unknown permission")
    row = db.scalar(select(RolePermission).where(
        RolePermission.role_id == body.role_id,
        RolePermission.permission_code == body.permission_code,
        RolePermission.division_id.is_(None) if body.division_id is None else RolePermission.division_id == body.division_id,
    ))
    if row is None:
        row = RolePermission(**body.model_dump())
        db.add(row)
    else:
        row.effect = body.effect
    db.flush()
    audit(db, actor_id=p.id, action="permission.grant", entity=row, division_id=body.division_id, changes=body.model_dump())
    db.commit()
    return row


def delete_grant(db: Session, p: Principal, grant_id: uuid.UUID) -> None:
    row = get_or_404(db, RolePermission, grant_id, "Grant")
    if row.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can change global grants", code="permission_denied")
    else:
        p.require("permissions.manage", row.division_id)
    audit(db, actor_id=p.id, action="permission.revoke_override", entity=row, division_id=row.division_id,
          changes={"role_id": row.role_id, "permission_code": row.permission_code, "effect": row.effect})
    db.delete(row)
    db.commit()


def list_grants(db: Session, p: Principal, division_id: uuid.UUID | None) -> list[RolePermission]:
    stmt = select(RolePermission).order_by(RolePermission.role_id, RolePermission.permission_code)
    if division_id is None:
        stmt = stmt.where(RolePermission.division_id.is_(None))
    else:
        if not p.can_access_division(division_id):
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        stmt = stmt.where(RolePermission.division_id == division_id)
    return list(db.scalars(stmt))


# ---- users -------------------------------------------------------------------------------------------------


def _assert_manageable(p: Principal, user: User) -> None:
    p.require("users.manage", user.division_id)
    if not p.can_manage_role(user.role_id):
        raise Forbidden("You cannot manage users of this role", code="hierarchy_forbidden")


def _visible(p: Principal, user: User, permission: str = "users.read") -> bool:
    if user.id == p.id:
        return True
    return p.has(permission, user.division_id) and p.can_manage_role(user.role_id)


def _validate_role_division(db: Session, p: Principal, role_id: int, division_id: uuid.UUID) -> None:
    division = get_or_404(db, Division, division_id, "Division")
    if not division.is_active:
        raise BusinessRuleViolation("Division is inactive")
    p.require("users.manage", division_id)
    if not p.can_manage_role(role_id):
        raise Forbidden("You cannot assign this role", code="hierarchy_forbidden")


def create_user(db: Session, p: Principal, body: UserCreate) -> User:
    _validate_role_division(db, p, body.role_id, body.division_id)
    data = body.model_dump()
    if data["email"]:
        data["email"] = data["email"].lower()
    user = User(**data, created_by_id=p.id, status=UserStatus.ACTIVE)
    db.add(user)
    flush_or_conflict(db, "Employee ID, email, mobile or Firebase account already in use")
    audit(db, actor_id=p.id, action="user.create", entity=user, division_id=user.division_id,
          changes={k: v for k, v in data.items() if k != "firebase_uid"})
    commit_or_conflict(db, "Employee ID, email, mobile or Firebase account already in use")
    return user


def update_user(db: Session, p: Principal, user_id: uuid.UUID, body: UserUpdate) -> User:
    user = get_or_404(db, User, user_id, "User")
    if user.status == UserStatus.DELETED:
        raise NotFound("User not found")
    _assert_manageable(p, user)
    updates = body.model_dump(exclude_unset=True)
    if "email" in updates and updates["email"]:
        updates["email"] = updates["email"].lower()
    new_role = updates.get("role_id", user.role_id)
    new_div = updates.get("division_id", user.division_id)
    if new_role != user.role_id or new_div != user.division_id:
        _validate_role_division(db, p, new_role, new_div)
    audit(db, actor_id=p.id, action="user.update", entity=user, division_id=user.division_id, changes=diff(user, updates))
    for k, v in updates.items():
        setattr(user, k, v)
    commit_or_conflict(db, "Employee ID, email, mobile or Firebase account already in use")
    return user


def set_user_status(db: Session, p: Principal, user_id: uuid.UUID, status: UserStatus) -> User:
    user = get_or_404(db, User, user_id, "User")
    if user.status == UserStatus.DELETED:
        raise NotFound("User not found")
    if user.id == p.id:
        raise BusinessRuleViolation("You cannot change your own status")
    _assert_manageable(p, user)
    audit(db, actor_id=p.id, action=f"user.status.{status.value}", entity=user, division_id=user.division_id,
          changes={"status": {"from": user.status, "to": status}})
    user.status = status
    if status == UserStatus.DELETED:
        user.deleted_at = utcnow()
    commit_or_conflict(db, "Reactivation conflicts with an existing active user")
    return user


def get_user(db: Session, p: Principal, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None or user.status == UserStatus.DELETED or not _visible(p, user):
        raise NotFound("User not found")
    return user


def list_users(db: Session, p: Principal, params: PageParams, *, role_id: int | None, status: UserStatus | None,
               division_id: uuid.UUID | None, q: str | None) -> tuple[list[User], int]:
    divisions = p.require_any_division("users.read")
    if division_id is not None:
        if division_id not in divisions:
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        divisions = [division_id]
    roles = [int(r) for r in RoleId if p.can_manage_role(r)]
    stmt = select(User).where(User.division_id.in_(divisions), or_(User.role_id.in_(roles), User.id == p.id))
    stmt = stmt.where(User.status == status) if status else stmt.where(User.status != UserStatus.DELETED)
    if role_id:
        stmt = stmt.where(User.role_id == role_id)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.name).like(like), func.lower(User.emp_id).like(like), User.mobile.like(like)))
    return paginate(db, stmt.order_by(User.name, User.id), params)


def get_kyc(db: Session, p: Principal, user_id: uuid.UUID) -> EmployeeKyc:
    user = get_or_404(db, User, user_id, "User")
    if not (user.id == p.id or _visible(p, user, "users.kyc.read")):
        raise Forbidden("Not allowed to read KYC data", code="permission_denied")
    kyc = db.get(EmployeeKyc, user_id)
    if kyc is None:
        raise NotFound("No KYC record")
    audit(db, actor_id=p.id, action="user.kyc.read", entity=kyc, division_id=user.division_id)
    db.commit()
    return kyc


def put_kyc(db: Session, p: Principal, user_id: uuid.UUID, body: KycIn) -> EmployeeKyc:
    from app.models import MediaObject, MediaStatus

    user = get_or_404(db, User, user_id, "User")
    if not _visible(p, user, "users.kyc.manage"):
        raise Forbidden("Not allowed to modify KYC data", code="permission_denied")
    for media_id in body.documents.values():
        media = db.get(MediaObject, media_id)
        if media is None or media.status != MediaStatus.UPLOADED or media.division_id != user.division_id:
            raise BusinessRuleViolation(f"Document {media_id} is not an uploaded file of this division")
    data = body.model_dump(exclude={"aadhaar_number"})
    data["documents"] = {k: str(v) for k, v in body.documents.items()}
    if body.aadhaar_number:
        data["aadhaar_last4"] = body.aadhaar_number[-4:]
    kyc = db.get(EmployeeKyc, user_id)
    if kyc is None:
        kyc = EmployeeKyc(user_id=user_id, **data)
        db.add(kyc)
    else:
        for k, v in data.items():
            setattr(kyc, k, v)
    db.flush()
    audit(db, actor_id=p.id, action="user.kyc.update", entity=kyc, division_id=user.division_id,
          changes={"fields": sorted(k for k, v in data.items() if v is not None)})
    db.commit()
    return kyc


# ---- charge maps -------------------------------------------------------------------------------------------


def create_charge(db: Session, p: Principal, body: ChargeMapCreate) -> ChargeMap:
    user = get_or_404(db, User, body.user_id, "User")
    get_or_404(db, Division, body.division_id, "Division")
    if user.status != UserStatus.ACTIVE:
        raise BusinessRuleViolation("User is not active")
    if RoleId(user.role_id) not in CHARGE_ELIGIBLE_ROLES:
        raise BusinessRuleViolation("This role cannot hold temporary charge")
    if body.division_id == user.division_id:
        raise BusinessRuleViolation("User already belongs to that division")
    p.require("charge.manage", user.division_id)
    p.require("charge.manage", body.division_id)
    if not p.can_manage_role(user.role_id):
        raise Forbidden("You cannot manage users of this role", code="hierarchy_forbidden")
    overlap = db.scalar(select(ChargeMap.id).where(
        ChargeMap.user_id == user.id, ChargeMap.division_id == body.division_id, ChargeMap.is_active.is_(True),
        ChargeMap.from_date <= body.to_date, ChargeMap.to_date >= body.from_date,
    ))
    if overlap:
        raise Conflict("Overlapping charge already exists")
    charge = ChargeMap(**body.model_dump(), created_by_id=p.id)
    db.add(charge)
    db.flush()
    audit(db, actor_id=p.id, action="charge.create", entity=charge, division_id=body.division_id, changes=body.model_dump())
    db.commit()
    return charge


def end_charge(db: Session, p: Principal, charge_id: uuid.UUID) -> ChargeMap:
    charge = get_or_404(db, ChargeMap, charge_id, "Charge")
    p.require("charge.manage", charge.division_id)
    charge.is_active = False
    audit(db, actor_id=p.id, action="charge.end", entity=charge, division_id=charge.division_id)
    db.commit()
    return charge


def list_charges(db: Session, p: Principal) -> list[ChargeMap]:
    divisions = p.require_any_division("charge.manage")
    return list(db.scalars(select(ChargeMap).where(ChargeMap.division_id.in_(divisions)).order_by(ChargeMap.from_date.desc())))


def roles(db: Session) -> list[Role]:
    return list(db.scalars(select(Role).order_by(Role.level)))


def permissions(db: Session) -> list[Permission]:
    return list(db.scalars(select(Permission).order_by(Permission.module, Permission.code)))
