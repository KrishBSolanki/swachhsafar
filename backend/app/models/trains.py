import uuid
from datetime import time
from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, Time, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, str_enum


class CoachClass(StrEnum):
    AC = "AC"
    NON_AC = "NON_AC"


class Train(UUIDPk, Timestamps, Base):
    __tablename__ = "trains"
    __table_args__ = (
        UniqueConstraint("division_id", "train_no"),
        CheckConstraint("duration_days >= 0 AND duration_days <= 15", name="duration_range"),
        CheckConstraint("operational_days >= 1 AND operational_days <= 30", name="operational_days_range"),
        CheckConstraint("inspection_rounds_per_day >= 1 AND inspection_rounds_per_day <= 20", name="rounds_range"),
        CheckConstraint("before_inspection_enabled OR after_inspection_enabled", name="some_phase_enabled"),
    )

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    train_no: Mapped[str] = mapped_column(String(15), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Days from departure to the start of the linked/return leg.
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # Number of operational journey days for inspections/feedback (day 1..N).
    operational_days: Mapped[int] = mapped_column(Integer, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    return_start_time: Mapped[time | None] = mapped_column(Time)
    return_end_time: Mapped[time | None] = mapped_column(Time)
    daywise: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inspection_rounds_per_day: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    before_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    after_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    coaches: Mapped[list["TrainCoach"]] = relationship(
        back_populates="train", cascade="all, delete-orphan", order_by="TrainCoach.position"
    )


class TrainCoach(UUIDPk, Base):
    __tablename__ = "train_coaches"
    __table_args__ = (UniqueConstraint("train_id", "code"), UniqueConstraint("train_id", "position"))

    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    classification: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    train: Mapped[Train] = relationship(back_populates="coaches")
