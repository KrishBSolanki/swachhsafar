import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import EmailStr, Field, model_validator

from app.models import PermissionEffect, UserStatus
from app.schemas.common import Mobile, ReadModel, StrictModel


class DivisionCreate(StrictModel):
    code: str = Field(min_length=2, max_length=16, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=2, max_length=100)


class DivisionUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    is_active: bool | None = None


class DivisionOut(ReadModel):
    id: uuid.UUID
    code: str
    name: str
    is_active: bool
    updated_at: datetime


class RoleOut(ReadModel):
    id: int
    code: str
    name: str
    level: int


class PermissionOut(ReadModel):
    code: str
    module: str
    description: str


class GrantIn(StrictModel):
    role_id: int = Field(ge=1, le=6)
    permission_code: str
    division_id: uuid.UUID | None = None
    effect: PermissionEffect = PermissionEffect.ALLOW


class GrantOut(ReadModel):
    id: uuid.UUID
    role_id: int
    permission_code: str
    division_id: uuid.UUID | None
    effect: PermissionEffect


class UserCreate(StrictModel):
    emp_id: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=2, max_length=100)
    name_hindi: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    mobile: Mobile | None = None
    gender: Literal["M", "F", "O"] | None = None
    designation: str | None = Field(default=None, max_length=100)
    lang: Literal["en", "hi"] = "en"
    role_id: int = Field(ge=1, le=6)
    division_id: uuid.UUID
    firebase_uid: str | None = Field(default=None, max_length=128)


class UserUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    name_hindi: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    mobile: Mobile | None = None
    gender: Literal["M", "F", "O"] | None = None
    designation: str | None = Field(default=None, max_length=100)
    lang: Literal["en", "hi"] | None = None
    role_id: int | None = Field(default=None, ge=1, le=6)
    division_id: uuid.UUID | None = None
    firebase_uid: str | None = Field(default=None, max_length=128)


class UserStatusIn(StrictModel):
    status: Literal[UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.DELETED]


class UserOut(ReadModel):
    id: uuid.UUID
    emp_id: str
    name: str
    name_hindi: str | None
    email: str | None
    mobile: str | None
    gender: str | None
    designation: str | None
    lang: str
    role_id: int
    division_id: uuid.UUID
    status: UserStatus
    firebase_linked: bool
    updated_at: datetime


class MeOut(StrictModel):
    user: UserOut
    divisions: dict[uuid.UUID, list[str]]


class KycIn(StrictModel):
    father_name: str | None = Field(default=None, max_length=100)
    birth_date: date | None = None
    first_engaged_on: date | None = None
    rail_reg_id: str | None = Field(default=None, max_length=32)
    aadhaar_number: str | None = Field(default=None, pattern=r"^[0-9]{12}$", description="Only the last 4 digits are stored")
    education: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    documents: dict[str, uuid.UUID] = Field(default_factory=dict, description="document type -> media id")


class KycOut(ReadModel):
    user_id: uuid.UUID
    father_name: str | None
    birth_date: date | None
    first_engaged_on: date | None
    rail_reg_id: str | None
    aadhaar_last4: str | None
    education: str | None
    address: str | None
    documents: dict


class ChargeMapCreate(StrictModel):
    user_id: uuid.UUID
    division_id: uuid.UUID
    from_date: date
    to_date: date

    @model_validator(mode="after")
    def _range(self):
        if self.from_date > self.to_date:
            raise ValueError("from_date must not be after to_date")
        return self


class ChargeMapOut(ReadModel):
    id: uuid.UUID
    user_id: uuid.UUID
    division_id: uuid.UUID
    from_date: date
    to_date: date
    is_active: bool


class AuditOut(ReadModel):
    id: uuid.UUID
    created_at: datetime
    actor_id: uuid.UUID | None
    division_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: str
    changes: dict
