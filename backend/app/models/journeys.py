import uuid
from datetime import date, datetime, time
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, str_enum
from app.models.org import User
from app.models.trains import CoachClass, Train


class JourneyStatus(StrEnum):
    PLANNED = "planned"
    CANCELLED = "cancelled"


class JourneyState(StrEnum):
    """Derived, never stored."""

    SCHEDULED = "scheduled"
    ACTIVE = "active"
    HISTORY = "history"
    CANCELLED = "cancelled"


class Journey(UUIDPk, Timestamps, Base):
    __tablename__ = "journeys"
    __table_args__ = (
        CheckConstraint("linked_journey_date >= journey_date", name="linked_after_start"),
        CheckConstraint("end_date >= linked_journey_date", name="end_after_linked"),
        CheckConstraint(
            "outbound_end_date IS NULL OR (outbound_end_date >= journey_date AND outbound_end_date <= end_date)",
            name="outbound_end_range",
        ),
        Index("ix_journeys_division_dates", "division_id", "journey_date", "end_date"),
    )

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id"), nullable=False, index=True)
    linked_train_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trains.id"))
    journey_date: Mapped[date] = mapped_column(Date, nullable=False)
    outbound_end_date: Mapped[date | None] = mapped_column(Date)
    linked_journey_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    return_start_time: Mapped[time | None] = mapped_column(Time)
    return_end_time: Mapped[time | None] = mapped_column(Time)
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False)
    operational_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # Inspection configuration snapshot taken from the train when the journey is created.
    daywise: Mapped[bool] = mapped_column(Boolean, nullable=False)
    inspection_rounds_per_day: Mapped[int] = mapped_column(Integer, nullable=False)
    before_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    after_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    supervisor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    status: Mapped[JourneyStatus] = mapped_column(str_enum(JourneyStatus, 10), nullable=False, default=JourneyStatus.PLANNED)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    __mapper_args__ = {"version_id_col": version}

    train: Mapped[Train] = relationship(foreign_keys=[train_id], lazy="joined")
    linked_train: Mapped[Train | None] = relationship(foreign_keys=[linked_train_id], lazy="joined")
    supervisor: Mapped[User] = relationship(foreign_keys=[supervisor_id], lazy="joined")
    coaches: Mapped[list["JourneyCoach"]] = relationship(
        back_populates="journey", cascade="all, delete-orphan", order_by="JourneyCoach.position"
    )


class JourneyCoach(UUIDPk, Base):
    __tablename__ = "journey_coaches"
    __table_args__ = (UniqueConstraint("journey_id", "code"),)

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    classification: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    journey: Mapped[Journey] = relationship(back_populates="coaches")


class StaffAllocation(UUIDPk, Timestamps, Base):
    __tablename__ = "staff_allocations"
    __table_args__ = (
        Index(
            "uq_staff_allocations_live",
            "journey_id",
            "user_id",
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
        ),
    )

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    allocated_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="joined")
