"""Field operations captured on board: attendance and inspections."""

import uuid
from datetime import datetime
from enum import IntEnum, StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, GeoPoint, Timestamps, str_enum, TZDateTime


class AttendanceStage(IntEnum):
    SOURCE = 1
    ENROUTE_1 = 2
    DESTINATION = 3
    ENROUTE_2 = 4
    END = 5


class VerificationStatus(StrEnum):
    SUBMITTED = "submitted"
    VERIFIED = "verified"
    REJECTED = "rejected"


class InspectionPhase(StrEnum):
    BEFORE = "B"
    AFTER = "A"


class CapturedRecord(GeoPoint, Timestamps):
    """Common columns for device-captured records. The primary key is device-generated and doubles as the
    idempotency key; payload_hash detects a replay that carries different content."""

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    device_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    server_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        str_enum(VerificationStatus, 10), nullable=False, default=VerificationStatus.SUBMITTED
    )
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    verified_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    review_remarks: Mapped[str | None] = mapped_column(String(500))
    sync_op_id: Mapped[uuid.UUID | None] = mapped_column()
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class Attendance(CapturedRecord, Base):
    __tablename__ = "attendance"
    __table_args__ = (
        UniqueConstraint("journey_id", "employee_id", "stage"),
        CheckConstraint("stage BETWEEN 1 AND 5", name="stage_range"),
    )

    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    stage: Mapped[int] = mapped_column(Integer, nullable=False)
    photo_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
    group_submission_id: Mapped[uuid.UUID | None] = mapped_column(index=True)


class Inspection(CapturedRecord, Base):
    __tablename__ = "inspections"
    __table_args__ = (
        UniqueConstraint("journey_id", "coach_code", "day", "round", "phase"),
        CheckConstraint("day >= 1", name="day_positive"),
        CheckConstraint("round >= 1", name="round_positive"),
        Index("ix_inspections_journey_day", "journey_id", "day"),
    )

    coach_code: Mapped[str] = mapped_column(String(10), nullable=False)
    day: Mapped[int] = mapped_column(Integer, nullable=False)
    round: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[InspectionPhase] = mapped_column(str_enum(InspectionPhase, 1), nullable=False)
    comments: Mapped[str | None] = mapped_column(Text)
    photo_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
    video_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
