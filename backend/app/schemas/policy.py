from pydantic import Field

from app.schemas.common import StrictModel


class PolicySettings(StrictModel):
    """Division operational policy. Defaults are the strict choice; a division relaxes them explicitly."""

    passenger_pnr_required: bool = True
    passenger_otp_required: bool = True
    # When true, PNR train must be the main train for the first half of the journey days and the linked
    # train for the second half; when false either train is accepted on any day.
    pnr_train_day_mapping: bool = False
    pnr_coach_match_required: bool = True
    passenger_feedback_per_coach_day: int | None = Field(default=None, ge=1, le=100)
    railway_feedback_limit_per_journey: int = Field(default=2, ge=0, le=50)
    attendance_photo_required: bool = True
    attendance_late_grace_days: int = Field(default=1, ge=0, le=7)
    inspection_photo_required: bool = True
    complaint_default_sla_hours: int = Field(default=72, ge=1, le=24 * 60)
