import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, str_enum
from app.models.trains import CoachClass


class ComplaintStatus(StrEnum):
    CREATED = "created"
    IN_PROCESS = "in_process"
    FORWARDED = "forwarded"
    COMPLETED = "completed"


class ComplaintDepartment(UUIDPk, Timestamps, Base):
    __tablename__ = "complaint_departments"
    __table_args__ = (UniqueConstraint("division_id", "name"),)

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class ComplaintCategory(UUIDPk, Timestamps, Base):
    """Two-level tree: parent_id NULL = main category, otherwise sub-category."""

    __tablename__ = "complaint_categories"
    __table_args__ = (
        UniqueConstraint("division_id", "parent_id", "name", postgresql_nulls_not_distinct=True),
        CheckConstraint("sla_hours IS NULL OR sla_hours > 0", name="sla_positive"),
    )

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("complaint_categories.id"))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    default_department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("complaint_departments.id"))
    sla_hours: Mapped[int | None] = mapped_column(Integer)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Complaint(Timestamps, Base):
    __tablename__ = "complaints"
    __table_args__ = (
        Index("ix_complaints_division_status", "division_id", "status"),
        CheckConstraint("(status = 'completed') = (closed_at IS NOT NULL)", name="closed_iff_completed"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    complaint_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    journey_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("journeys.id"), index=True)
    train_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trains.id"))
    coach_code: Mapped[str | None] = mapped_column(String(10))
    coach_class: Mapped[CoachClass | None] = mapped_column(str_enum(CoachClass, 8))
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("complaint_categories.id"), nullable=False)
    subcategory_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("complaint_categories.id"))
    description: Mapped[str] = mapped_column(Text, nullable=False)
    latitude: Mapped[float | None] = mapped_column()
    longitude: Mapped[float | None] = mapped_column()
    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("complaint_departments.id"))
    assigned_to_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[ComplaintStatus] = mapped_column(str_enum(ComplaintStatus, 12), nullable=False, default=ComplaintStatus.CREATED)
    sla_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    resolution_remarks: Mapped[str | None] = mapped_column(Text)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    device_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    server_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    history: Mapped[list["ComplaintHistory"]] = relationship(order_by="ComplaintHistory.created_at")
    attachments: Mapped[list["ComplaintAttachment"]] = relationship()

    @property
    def is_overdue(self) -> bool:
        from app.timeutil import utcnow

        return self.status != ComplaintStatus.COMPLETED and utcnow() > self.due_at

    @property
    def attachment_ids(self) -> list[uuid.UUID]:
        return [a.media_id for a in self.attachments]


class ComplaintHistory(UUIDPk, Base):
    __tablename__ = "complaint_history"

    complaint_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("complaints.id"), nullable=False, index=True)
    from_status: Mapped[ComplaintStatus | None] = mapped_column(str_enum(ComplaintStatus, 12))
    to_status: Mapped[ComplaintStatus] = mapped_column(str_enum(ComplaintStatus, 12), nullable=False)
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    forwarded_to_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("complaint_departments.id"))
    remarks: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ComplaintAttachment(Base):
    __tablename__ = "complaint_attachments"

    complaint_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("complaints.id"), primary_key=True)
    media_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("media_objects.id"), primary_key=True, unique=True)


class ComplaintCounter(Base):
    __tablename__ = "complaint_counters"

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
