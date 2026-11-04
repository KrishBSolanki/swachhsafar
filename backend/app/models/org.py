import uuid
from datetime import date, datetime
from enum import IntEnum, StrEnum

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, TZDateTime

JSONType = JSON().with_variant(JSONB(), "postgresql")


class RoleId(IntEnum):
    SUPER_ADMIN = 1
    ADMIN = 2
    MANAGER = 3
    SUPERVISOR = 4
    JANITOR = 5
    CONTRACTOR = 6


class UserStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    DELETED = "deleted"


class PermissionEffect(StrEnum):
    ALLOW = "allow"
    DENY = "deny"


class Division(UUIDPk, Timestamps, Base):
    __tablename__ = "divisions"

    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    level: Mapped[int] = mapped_column(Integer, nullable=False)


class Permission(Base):
    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    module: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(String(200), nullable=False)


class RolePermission(UUIDPk, Timestamps, Base):
    """Global grants have division_id NULL; a division row overrides the global one for that division."""

    __tablename__ = "role_permissions"
    __table_args__ = (
        Index(
            "uq_role_permissions_scope",
            "role_id",
            "permission_code",
            "division_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
    )

    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False)
    permission_code: Mapped[str] = mapped_column(ForeignKey("permissions.code"), nullable=False)
    division_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("divisions.id"), nullable=True)
    effect: Mapped[PermissionEffect] = mapped_column(
        Enum(PermissionEffect, native_enum=False, length=8, values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=PermissionEffect.ALLOW,
    )


class User(UUIDPk, Timestamps, Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("uq_users_emp_id_live", "emp_id", unique=True, postgresql_where=text("status <> 'deleted'"), sqlite_where=text("status <> 'deleted'")),
        Index("uq_users_email_live", func.lower(text("email")), unique=True, postgresql_where=text("status <> 'deleted' AND email IS NOT NULL"), sqlite_where=text("status <> 'deleted' AND email IS NOT NULL")),
        Index("uq_users_mobile_live", "mobile", unique=True, postgresql_where=text("status <> 'deleted' AND mobile IS NOT NULL"), sqlite_where=text("status <> 'deleted' AND mobile IS NOT NULL")),
        CheckConstraint("mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$'", name="mobile_format"),
    )

    firebase_uid: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    emp_id: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    name_hindi: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(254))
    mobile: Mapped[str | None] = mapped_column(String(10))
    gender: Mapped[str | None] = mapped_column(String(1))
    designation: Mapped[str | None] = mapped_column(String(100))
    lang: Mapped[str] = mapped_column(String(5), nullable=False, default="en")
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False, index=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    status: Mapped[UserStatus] = mapped_column(
        Enum(UserStatus, native_enum=False, length=10, values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=UserStatus.ACTIVE,
        index=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    role: Mapped[Role] = relationship(lazy="joined")
    division: Mapped[Division] = relationship(lazy="joined")
    kyc: Mapped["EmployeeKyc | None"] = relationship(back_populates="user", uselist=False)

    @property
    def firebase_linked(self) -> bool:
        return self.firebase_uid is not None


class EmployeeKyc(Timestamps, Base):
    """Restricted employee identity data. Readable only with users.kyc.read."""

    __tablename__ = "employee_kyc"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    father_name: Mapped[str | None] = mapped_column(String(100))
    birth_date: Mapped[date | None] = mapped_column(Date)
    first_engaged_on: Mapped[date | None] = mapped_column(Date)
    rail_reg_id: Mapped[str | None] = mapped_column(String(32))
    aadhaar_last4: Mapped[str | None] = mapped_column(String(4))
    education: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(Text)
    documents: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)

    user: Mapped[User] = relationship(back_populates="kyc")


class ChargeMap(UUIDPk, Timestamps, Base):
    """Temporary charge: the user acts with their own role in another division for a date range."""

    __tablename__ = "charge_maps"
    __table_args__ = (CheckConstraint("from_date <= to_date", name="date_range"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    from_date: Mapped[date] = mapped_column(Date, nullable=False)
    to_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)


class DivisionPolicy(Timestamps, Base):
    """Division-specific operational rules. Stored as validated JSON (see schemas.policy.PolicySettings)."""

    __tablename__ = "division_policies"

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), primary_key=True)
    settings: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


class AuditLog(UUIDPk, Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_logs_entity", "entity_type", "entity_id"),)

    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    division_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("divisions.id"), index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    changes: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)


__all__ = [
    "AuditLog",
    "ChargeMap",
    "Division",
    "DivisionPolicy",
    "EmployeeKyc",
    "Permission",
    "PermissionEffect",
    "Role",
    "RoleId",
    "RolePermission",
    "User",
    "UserStatus",
]
