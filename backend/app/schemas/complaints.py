import uuid
from datetime import datetime

from pydantic import Field, field_validator

from app.models import CoachClass, ComplaintStatus
from app.schemas.common import AwareDatetime, CoachCode, Latitude, Longitude, ReadModel, StrictModel


class DepartmentIn(StrictModel):
    division_id: uuid.UUID
    name: str = Field(min_length=2, max_length=100)


class DepartmentUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    is_active: bool | None = None


class DepartmentOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    name: str
    is_active: bool


class CategoryIn(StrictModel):
    division_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    name: str = Field(min_length=2, max_length=100)
    default_department_id: uuid.UUID | None = None
    sla_hours: int | None = Field(default=None, ge=1, le=24 * 60)
    sort_order: int = 0


class CategoryUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    default_department_id: uuid.UUID | None = None
    sla_hours: int | None = Field(default=None, ge=1, le=24 * 60)
    sort_order: int | None = None
    is_active: bool | None = None


class CategoryOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    default_department_id: uuid.UUID | None
    sla_hours: int | None
    sort_order: int
    is_active: bool


class ComplaintIn(StrictModel):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    division_id: uuid.UUID
    journey_id: uuid.UUID | None = None
    coach_code: CoachCode | None = None
    category_id: uuid.UUID
    subcategory_id: uuid.UUID | None = None
    description: str = Field(min_length=5, max_length=4000)
    latitude: Latitude | None = None
    longitude: Longitude | None = None
    device_timestamp: AwareDatetime
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)

    @field_validator("attachment_ids")
    @classmethod
    def _unique(cls, v):
        if len(set(v)) != len(v):
            raise ValueError("attachments must be unique")
        return v


class TransitionIn(StrictModel):
    to_status: ComplaintStatus
    remarks: str | None = Field(default=None, max_length=4000)
    forward_to_user_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None


class HistoryOut(ReadModel):
    id: uuid.UUID
    from_status: ComplaintStatus | None
    to_status: ComplaintStatus
    actor_id: uuid.UUID
    forwarded_to_id: uuid.UUID | None
    department_id: uuid.UUID | None
    remarks: str | None
    created_at: datetime


class ComplaintOut(ReadModel):
    id: uuid.UUID
    complaint_no: str
    division_id: uuid.UUID
    journey_id: uuid.UUID | None
    train_id: uuid.UUID | None
    coach_code: str | None
    coach_class: CoachClass | None
    category_id: uuid.UUID
    subcategory_id: uuid.UUID | None
    description: str
    latitude: float | None
    longitude: float | None
    department_id: uuid.UUID | None
    assigned_to_id: uuid.UUID | None
    status: ComplaintStatus
    sla_hours: int
    due_at: datetime
    is_overdue: bool
    resolution_remarks: str | None
    closed_at: datetime | None
    closed_by_id: uuid.UUID | None
    created_by_id: uuid.UUID
    server_timestamp: datetime
    attachment_ids: list[uuid.UUID]
    history: list[HistoryOut]
