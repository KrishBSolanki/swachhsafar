import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.models import CoachClass, OtpStatus, PassengerFeedbackStatus, PnrStatus
from app.schemas.common import Captured, CoachCode, Mobile, ReadModel, StrictModel

Audience = Literal["passenger", "railway"]


class QuestionIn(StrictModel):
    text_en: str = Field(min_length=3, max_length=500)
    text_hi: str | None = Field(default=None, max_length=500)
    applies_ac: bool = True
    applies_non_ac: bool = True
    required: bool = True
    psi_weight: float | None = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def _applies(self):
        if not (self.applies_ac or self.applies_non_ac):
            raise ValueError("question must apply to AC, Non-AC or both")
        return self


class QuestionBankCreate(StrictModel):
    division_id: uuid.UUID | None = Field(default=None, description="NULL = default bank (Super Admin only)")
    audience: Audience
    name: str = Field(min_length=3, max_length=100)
    scale_min: int = Field(ge=0, le=10)
    scale_max: int = Field(ge=1, le=10)
    questions: list[QuestionIn] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def _scale(self):
        if self.scale_min >= self.scale_max:
            raise ValueError("scale_min must be less than scale_max")
        return self


class QuestionOut(ReadModel):
    id: uuid.UUID
    position: int
    text_en: str
    text_hi: str | None
    applies_ac: bool
    applies_non_ac: bool
    required: bool
    psi_weight: float | None


class QuestionBankOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID | None
    audience: str
    name: str
    scale_min: int
    scale_max: int
    is_active: bool
    questions: list[QuestionOut]
    updated_at: datetime


class Rating(StrictModel):
    question_id: uuid.UUID
    value: int


def _unique_ratings(v: list[Rating]) -> list[Rating]:
    if len({r.question_id for r in v}) != len(v):
        raise ValueError("one rating per question")
    return v


class PassengerFeedbackStart(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    coach_code: CoachCode
    journey_day: int = Field(ge=1, le=30)
    passenger_name: str = Field(min_length=2, max_length=100)
    mobile: Mobile
    pnr: str | None = Field(default=None, pattern=r"^[0-9]{10}$")
    seat_no: str | None = Field(default=None, max_length=10)


class OtpVerify(StrictModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


class PassengerFeedbackComplete(StrictModel):
    ratings: list[Rating] = Field(min_length=1, max_length=20)
    comments: str | None = Field(default=None, max_length=2000)
    voice_media_id: uuid.UUID | None = None

    _u = field_validator("ratings")(_unique_ratings)


class VoidIn(StrictModel):
    reason: str = Field(min_length=3, max_length=200)


class RatingOut(ReadModel):
    question_id: uuid.UUID
    value: int


class PassengerFeedbackOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    bank_id: uuid.UUID
    coach_code: str
    coach_class: CoachClass
    journey_day: int
    feedback_date: date
    passenger_name: str
    mobile_masked: str
    pnr: str | None
    seat_no: str | None
    status: PassengerFeedbackStatus
    pnr_status: PnrStatus
    otp_status: OtpStatus
    void_reason: str | None
    comments: str | None
    voice_media_id: uuid.UUID | None
    ratings: list[RatingOut]
    collected_by_id: uuid.UUID
    device_timestamp: datetime
    server_timestamp: datetime
    verified_at: datetime | None
    completed_at: datetime | None


class OtpSent(StrictModel):
    otp_status: OtpStatus
    expires_at: datetime
    resend_available_at: datetime
    sends_remaining: int
    mobile_masked: str


class RailwayFeedbackIn(Captured):
    id: uuid.UUID
    journey_id: uuid.UUID
    railway_employee_id: str = Field(min_length=2, max_length=32)
    official_name: str = Field(min_length=2, max_length=100)
    designation: str | None = Field(default=None, max_length=100)
    coach_code: CoachCode | None = None
    journey_day: int = Field(ge=1, le=30)
    ratings: list[Rating] = Field(min_length=1, max_length=20)
    comments: str | None = Field(default=None, max_length=2000)

    _u = field_validator("ratings")(_unique_ratings)


class RailwayFeedbackOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    bank_id: uuid.UUID
    railway_employee_id: str
    official_name: str
    designation: str | None
    coach_code: str | None
    journey_day: int
    comments: str | None
    verification_status: str
    # When / by whom the current verification_status was set (null until reviewed). Devices use verified_at
    # to order status updates, so an older response never overwrites a newer review.
    verified_at: datetime | None = None
    verified_by_id: uuid.UUID | None = None
    ratings: list[RatingOut]
    created_by_id: uuid.UUID
    device_timestamp: datetime
    server_timestamp: datetime
