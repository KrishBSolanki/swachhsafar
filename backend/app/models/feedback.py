import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, GeoPoint, Timestamps, UUIDPk, str_enum, TZDateTime
from app.models.org import JSONType
from app.models.trains import CoachClass


class QuestionBank(UUIDPk, Timestamps, Base):
    """A versioned set of rating questions. division_id NULL = default bank for divisions without their own."""

    __tablename__ = "question_banks"
    __table_args__ = (
        CheckConstraint("scale_min < scale_max", name="scale_order"),
        Index("uq_question_banks_active_division", "division_id", "audience", unique=True,
              postgresql_where=text("is_active AND division_id IS NOT NULL"), sqlite_where=text("is_active AND division_id IS NOT NULL")),
        Index("uq_question_banks_active_default", "audience", unique=True,
              postgresql_where=text("is_active AND division_id IS NULL"), sqlite_where=text("is_active AND division_id IS NULL")),
    )

    division_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("divisions.id"))
    audience: Mapped[str] = mapped_column(String(10), nullable=False)  # passenger | railway
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    scale_min: Mapped[int] = mapped_column(Integer, nullable=False)
    scale_max: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    questions: Mapped[list["Question"]] = relationship(
        back_populates="bank", cascade="all, delete-orphan", order_by="Question.position"
    )


class Question(UUIDPk, Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("bank_id", "position"),
        CheckConstraint("applies_ac OR applies_non_ac", name="applies_somewhere"),
    )

    bank_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("question_banks.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    text_en: Mapped[str] = mapped_column(Text, nullable=False)
    text_hi: Mapped[str | None] = mapped_column(Text)
    applies_ac: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    applies_non_ac: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Weight used by the PSI calculation. NULL on every question of a bank = PSI not configured.
    psi_weight: Mapped[float | None] = mapped_column(Numeric(6, 3, asdecimal=False))

    bank: Mapped[QuestionBank] = relationship(back_populates="questions")


class PassengerFeedbackStatus(StrEnum):
    DRAFT = "draft"              # captured, external verification outstanding
    VERIFIED = "verified"        # PNR (if required) and OTP (if required) passed
    COMPLETED = "completed"      # ratings submitted
    VOID = "void"                # cancelled / failed


class PnrStatus(StrEnum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    VALID = "valid"
    INVALID = "invalid"


class OtpStatus(StrEnum):
    NOT_REQUIRED = "not_required"
    NOT_SENT = "not_sent"
    SENT = "sent"
    VERIFIED = "verified"
    LOCKED = "locked"


COUNTED_STATUSES = "status IN ('verified','completed')"


class PassengerFeedback(GeoPoint, Timestamps, Base):
    __tablename__ = "passenger_feedback"
    __table_args__ = (
        Index("uq_passenger_feedback_pnr", "journey_id", "pnr", unique=True, postgresql_where=text(COUNTED_STATUSES), sqlite_where=text(COUNTED_STATUSES)),
        Index("uq_passenger_feedback_mobile_day", "journey_id", "mobile", "feedback_date", unique=True,
              postgresql_where=text(COUNTED_STATUSES), sqlite_where=text(COUNTED_STATUSES)),
        CheckConstraint("pnr IS NULL OR pnr ~ '^[0-9]{10}$'", name="pnr_format"),
        CheckConstraint("mobile ~ '^[6-9][0-9]{9}$'", name="mobile_format"),
        CheckConstraint("journey_day >= 1", name="day_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    bank_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("question_banks.id"), nullable=False)
    coach_code: Mapped[str] = mapped_column(String(10), nullable=False)
    coach_class: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    journey_day: Mapped[int] = mapped_column(Integer, nullable=False)
    feedback_date: Mapped[date] = mapped_column(Date, nullable=False)
    passenger_name: Mapped[str] = mapped_column(String(100), nullable=False)
    mobile: Mapped[str] = mapped_column(String(10), nullable=False)
    pnr: Mapped[str | None] = mapped_column(String(10))
    seat_no: Mapped[str | None] = mapped_column(String(10))
    comments: Mapped[str | None] = mapped_column(Text)
    voice_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
    status: Mapped[PassengerFeedbackStatus] = mapped_column(
        str_enum(PassengerFeedbackStatus, 10), nullable=False, default=PassengerFeedbackStatus.DRAFT, index=True
    )
    pnr_status: Mapped[PnrStatus] = mapped_column(str_enum(PnrStatus, 14), nullable=False)
    pnr_details: Mapped[dict | None] = mapped_column(JSONType)
    pnr_checked_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    otp_status: Mapped[OtpStatus] = mapped_column(str_enum(OtpStatus, 14), nullable=False)
    void_reason: Mapped[str | None] = mapped_column(String(200))
    device_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    server_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    collected_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    ratings: Mapped[list["PassengerFeedbackRating"]] = relationship(cascade="all, delete-orphan")

    @property
    def mobile_masked(self) -> str:
        return f"{self.mobile[:2]}XXXXXX{self.mobile[-2:]}"


class PassengerFeedbackRating(Base):
    __tablename__ = "passenger_feedback_ratings"

    feedback_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("passenger_feedback.id", ondelete="CASCADE"), primary_key=True)
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id"), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False)


class OtpChallenge(UUIDPk, Timestamps, Base):
    """Only an HMAC of the code is stored. One challenge per feedback; resends rotate the code."""

    __tablename__ = "otp_challenges"

    feedback_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("passenger_feedback.id", ondelete="CASCADE"), unique=True, nullable=False)
    mobile: Mapped[str] = mapped_column(String(10), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    send_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_sent_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(TZDateTime())


class RailwayFeedback(GeoPoint, Timestamps, Base):
    __tablename__ = "railway_feedback"
    __table_args__ = (CheckConstraint("journey_day >= 1", name="day_positive"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    bank_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("question_banks.id"), nullable=False)
    railway_employee_id: Mapped[str] = mapped_column(String(32), nullable=False)
    official_name: Mapped[str] = mapped_column(String(100), nullable=False)
    designation: Mapped[str | None] = mapped_column(String(100))
    coach_code: Mapped[str | None] = mapped_column(String(10))
    journey_day: Mapped[int] = mapped_column(Integer, nullable=False)
    comments: Mapped[str | None] = mapped_column(Text)
    verification_status: Mapped[str] = mapped_column(String(10), nullable=False, default="submitted")
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    verified_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    device_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    server_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    ratings: Mapped[list["RailwayFeedbackRating"]] = relationship(cascade="all, delete-orphan")


class RailwayFeedbackRating(Base):
    __tablename__ = "railway_feedback_ratings"

    feedback_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("railway_feedback.id", ondelete="CASCADE"), primary_key=True)
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id"), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False)
