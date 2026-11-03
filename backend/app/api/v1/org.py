import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import Forbidden
from app.models import AuditLog, UserStatus
from app.schemas.common import Page, PageParams
from app.schemas.org import (
    AuditOut,
    ChargeMapCreate,
    ChargeMapOut,
    DivisionCreate,
    DivisionOut,
    DivisionUpdate,
    GrantIn,
    GrantOut,
    KycIn,
    KycOut,
    MeOut,
    PermissionOut,
    RoleOut,
    UserCreate,
    UserOut,
    UserStatusIn,
    UserUpdate,
)
from app.schemas.policy import PolicySettings
from app.security.principal import Principal, get_principal
from app.services import org, policy
from app.services.common import paginate

auth_router = APIRouter(prefix="/auth", tags=["auth"])
users_router = APIRouter(prefix="/users", tags=["users"])
roles_router = APIRouter(prefix="/roles", tags=["roles"])
divisions_router = APIRouter(prefix="/divisions", tags=["divisions"])
permissions_router = APIRouter(prefix="/permissions", tags=["permissions"])
audit_router = APIRouter(prefix="/audit", tags=["audit"])


@auth_router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(get_principal)):
    return MeOut(user=UserOut.model_validate(p.user),
                 divisions={d: sorted(p.permissions_in(d)) for d in p.division_ids})


# ---- users -------------------------------------------------------------------------------------------------

@users_router.get("", response_model=Page[UserOut])
def list_users(params: PageParams = Depends(), role_id: int | None = None, status_: UserStatus | None = Query(None, alias="status"),
               division_id: uuid.UUID | None = None, q: str | None = Query(None, max_length=50),
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = org.list_users(db, p, params, role_id=role_id, status=status_, division_id=division_id, q=q)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@users_router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.create_user(db, p, body)


@users_router.get("/charge-maps", response_model=list[ChargeMapOut])
def list_charges(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_charges(db, p)


@users_router.post("/charge-maps", response_model=ChargeMapOut, status_code=status.HTTP_201_CREATED)
def create_charge(body: ChargeMapCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.create_charge(db, p, body)


@users_router.post("/charge-maps/{charge_id}/end", response_model=ChargeMapOut)
def end_charge(charge_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.end_charge(db, p, charge_id)


@users_router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.get_user(db, p, user_id)


@users_router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.update_user(db, p, user_id, body)


@users_router.post("/{user_id}/status", response_model=UserOut)
def set_status(user_id: uuid.UUID, body: UserStatusIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.set_user_status(db, p, user_id, UserStatus(body.status))


@users_router.get("/{user_id}/kyc", response_model=KycOut)
def get_kyc(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.get_kyc(db, p, user_id)


@users_router.put("/{user_id}/kyc", response_model=KycOut)
def put_kyc(user_id: uuid.UUID, body: KycIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.put_kyc(db, p, user_id, body)


# ---- roles / permissions / divisions -----------------------------------------------------------------------

@roles_router.get("", response_model=list[RoleOut])
def list_roles(db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return org.roles(db)


@permissions_router.get("", response_model=list[PermissionOut])
def list_permissions(db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return org.permissions(db)


@permissions_router.get("/grants", response_model=list[GrantOut])
def list_grants(division_id: uuid.UUID | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_grants(db, p, division_id)


@permissions_router.put("/grants", response_model=GrantOut)
def upsert_grant(body: GrantIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.upsert_grant(db, p, body)


@permissions_router.delete("/grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_grant(grant_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    org.delete_grant(db, p, grant_id)


@divisions_router.get("", response_model=list[DivisionOut])
def list_divisions(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_divisions(db, p)


@divisions_router.post("", response_model=DivisionOut, status_code=status.HTTP_201_CREATED)
def create_division(body: DivisionCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.create_division(db, p, body)


@divisions_router.patch("/{division_id}", response_model=DivisionOut)
def update_division(division_id: uuid.UUID, body: DivisionUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.update_division(db, p, division_id, body)


@divisions_router.get("/{division_id}/policy", response_model=PolicySettings)
def get_policy(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    if not p.can_access_division(division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    return policy.get_policy(db, division_id)


@divisions_router.put("/{division_id}/policy", response_model=PolicySettings)
def put_policy(division_id: uuid.UUID, body: PolicySettings, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    p.require("policies.manage", division_id)
    return policy.set_policy(db, division_id, body, p.id)


@audit_router.get("", response_model=Page[AuditOut])
def list_audit(params: PageParams = Depends(), entity_type: str | None = None, entity_id: str | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    divisions = p.require_any_division("audit.read")
    stmt = select(AuditLog).where(AuditLog.division_id.in_(divisions))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    items, total = paginate(db, stmt.order_by(AuditLog.created_at.desc()), params)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)
