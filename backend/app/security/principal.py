import uuid
from dataclasses import dataclass, field

from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import Forbidden, Unauthenticated
from app.models import ChargeMap, PermissionEffect, RoleId, RolePermission, User, UserStatus
from app.security.catalog import MANAGEABLE_ROLES
from app.security.tokens import TokenVerifier, get_token_verifier
from app.timeutil import today_ist


@dataclass
class Principal:
    """The authenticated caller. Role and divisions come from PostgreSQL, never from the request."""

    user: User
    division_ids: frozenset[uuid.UUID]
    _db: Session
    _perm_cache: dict[uuid.UUID, frozenset[str]] = field(default_factory=dict)

    @property
    def id(self) -> uuid.UUID:
        return self.user.id

    @property
    def role(self) -> RoleId:
        return RoleId(self.user.role_id)

    @property
    def is_super_admin(self) -> bool:
        return self.role == RoleId.SUPER_ADMIN

    def can_access_division(self, division_id: uuid.UUID) -> bool:
        return self.is_super_admin or division_id in self.division_ids

    def permissions_in(self, division_id: uuid.UUID) -> frozenset[str]:
        if division_id not in self._perm_cache:
            rows = self._db.execute(
                select(RolePermission.permission_code, RolePermission.division_id, RolePermission.effect).where(
                    RolePermission.role_id == self.user.role_id,
                    (RolePermission.division_id.is_(None)) | (RolePermission.division_id == division_id),
                )
            ).all()
            granted = {code for code, div, eff in rows if div is None and eff == PermissionEffect.ALLOW}
            for code, div, eff in rows:
                if div is not None:
                    (granted.add if eff == PermissionEffect.ALLOW else granted.discard)(code)
            self._perm_cache[division_id] = frozenset(granted)
        return self._perm_cache[division_id]

    def has(self, permission: str, division_id: uuid.UUID) -> bool:
        return self.can_access_division(division_id) and permission in self.permissions_in(division_id)

    def require(self, permission: str, division_id: uuid.UUID) -> None:
        if not self.can_access_division(division_id):
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        if permission not in self.permissions_in(division_id):
            raise Forbidden(f"Missing permission {permission}", code="permission_denied")

    def require_any_division(self, permission: str) -> list[uuid.UUID]:
        """Divisions in which the caller holds the permission (for list endpoints). Empty -> forbidden."""
        divisions = [d for d in self.scope_divisions() if permission in self.permissions_in(d)]
        if not divisions:
            raise Forbidden(f"Missing permission {permission}", code="permission_denied")
        return divisions

    def scope_divisions(self) -> list[uuid.UUID]:
        if self.is_super_admin:
            from app.models import Division

            return list(self._db.scalars(select(Division.id)))
        return list(self.division_ids)

    def can_manage_role(self, role_id: int) -> bool:
        return RoleId(role_id) in MANAGEABLE_ROLES[self.role]


def resolve_principal(db: Session, claims: dict) -> Principal:
    uid = claims.get("uid") or claims.get("sub")
    if not uid:
        raise Unauthenticated("Token has no subject")
    user = db.scalar(select(User).where(User.firebase_uid == uid))
    if user is None and claims.get("email") and claims.get("email_verified") is True:
        # First sign-in of a provisioned employee: link by verified email only.
        user = db.scalar(
            select(User).where(
                User.firebase_uid.is_(None),
                User.status != UserStatus.DELETED,
                User.email.ilike(claims["email"]),
            )
        )
        if user is not None:
            user.firebase_uid = uid
            db.commit()
    if user is None:
        raise Forbidden("Account is not provisioned for operations", code="not_provisioned")
    if user.status != UserStatus.ACTIVE:
        raise Forbidden("Account is not active", code="account_inactive")

    today = today_ist()
    charge = db.scalars(
        select(ChargeMap.division_id).where(
            ChargeMap.user_id == user.id,
            ChargeMap.is_active.is_(True),
            ChargeMap.from_date <= today,
            ChargeMap.to_date >= today,
        )
    ).all()
    return Principal(user=user, division_ids=frozenset({user.division_id, *charge}), _db=db)


def get_principal(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    verifier: TokenVerifier = Depends(get_token_verifier),
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthenticated("Missing bearer token")
    claims = verifier.verify(authorization.split(" ", 1)[1].strip())
    return resolve_principal(db, claims)
