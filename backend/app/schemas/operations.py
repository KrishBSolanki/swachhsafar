import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.models import InspectionPhase, VerificationStatus
from app.schemas.common import Accuracy, AwareDatetime, Captured, CoachCode, Latitude, Longitude, ReadModel, StrictModel


class AttendanceIn(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    employee_id: uuid.UUID
    stage: int = Field(ge=1, le=5, description="1 Source, 2 Enroute 1, 3 Destination, 4 Enroute 2, 5 End")
    photo_media_id: uuid.UUID | None = None
    group_submission_id: uuid.UUID | None = None


class GroupMember(StrictModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    photo_media_id: uuid.UUID | None = None


class GroupAttendanceIn(StrictModel):
    group_submission_id: uuid.UUID
    journey_id: uuid.UUID
    stage: int = Field(ge=1, le=5)
    device_timestamp: AwareDatetime
    latitude: Latitude
    longitude: Longitude
    gps_accuracy_m: Accuracy | None = None
    members: list[GroupMember] = Field(min_length=1, max_length=100)

    @field_validator("members")
    @classmethod
    def _unique(cls, v: list[GroupMember]):
        if len({m.employee_id for m in v}) != len(v) or len({m.id for m in v}) != len(v):
            raise ValueError("members must be unique")
        return v


class ReviewIn(StrictModel):
    status: Literal[VerificationStatus.VERIFIED, VerificationStatus.REJECTED]
    remarks: str | None = Field(default=None, max_length=500)


class AttendanceOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    employee_id: uuid.UUID
    stage: int
    device_timestamp: datetime
    server_timestamp: datetime
    latitude: float
    longitude: float
    gps_accuracy_m: float | None
    photo_media_id: uuid.UUID | None
    group_submission_id: uuid.UUID | None
    created_by_id: uuid.UUID
    verification_status: VerificationStatus
    verified_by_id: uuid.UUID | None
    review_remarks: str | None
    sync_op_id: uuid.UUID | None


class GroupResult(StrictModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    outcome: Literal["created", "replayed", "rejected"]
    error: dict | None = None
    record: AttendanceOut | None = None


class StageCell(StrictModel):
    stage: int
    status: Literal["taken", "next", "locked"]
    attendance_id: uuid.UUID | None = None


class StaffAttendanceStatus(StrictModel):
    employee_id: uuid.UUID
    name: str
    emp_id: str
    role_id: int
    stages: list[StageCell]
    completed: bool


class InspectionIn(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    coach_code: CoachCode
    day: int = Field(ge=1, le=30)
    round: int = Field(ge=1, le=20)
    phase: InspectionPhase
    comments: str | None = Field(default=None, max_length=2000)
    photo_media_id: uuid.UUID | None = None
    video_media_id: uuid.UUID | None = None


class InspectionOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    coach_code: str
    day: int
    round: int
    phase: InspectionPhase
    comments: str | None
    device_timestamp: datetime
    server_timestamp: datetime
    latitude: float
    longitude: float
    gps_accuracy_m: float | None
    photo_media_id: uuid.UUID | None
    video_media_id: uuid.UUID | None
    created_by_id: uuid.UUID
    verification_status: VerificationStatus
    review_remarks: str | None


class InspectionCell(StrictModel):
    round: int
    phase: InspectionPhase
    status: Literal["taken", "open", "locked"]
    inspection_id: uuid.UUID | None = None


class CoachDayStatus(StrictModel):
    coach_code: str
    day: int
    day_open: bool
    required: int
    done: int
    cells: list[InspectionCell]
