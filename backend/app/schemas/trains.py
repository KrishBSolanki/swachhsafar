import uuid
from datetime import datetime, time

from pydantic import Field, field_validator, model_validator

from app.models import CoachClass
from app.schemas.common import CoachCode, ReadModel, StrictModel


class CoachIn(StrictModel):
    code: CoachCode
    classification: CoachClass


class CoachOut(ReadModel):
    code: str
    classification: CoachClass
    position: int


class _TrainFields(StrictModel):
    name: str = Field(min_length=2, max_length=100)
    duration_days: int = Field(ge=0, le=15)
    operational_days: int = Field(ge=1, le=30)
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    daywise: bool = False
    inspection_rounds_per_day: int = Field(default=1, ge=1, le=20)
    before_inspection_enabled: bool = False
    after_inspection_enabled: bool = True


def _unique_codes(coaches: list[CoachIn]) -> list[CoachIn]:
    codes = [c.code for c in coaches]
    if len(codes) != len(set(codes)):
        raise ValueError("coach codes must be unique")
    return coaches


class TrainCreate(_TrainFields):
    division_id: uuid.UUID
    train_no: str = Field(min_length=3, max_length=15, pattern=r"^[0-9A-Z]+( / [0-9A-Z]+)?$")
    coaches: list[CoachIn] = Field(min_length=1, max_length=40)

    _codes = field_validator("coaches")(_unique_codes)

    @model_validator(mode="after")
    def _phase(self):
        if not (self.before_inspection_enabled or self.after_inspection_enabled):
            raise ValueError("at least one inspection phase must be enabled")
        return self


class TrainUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    duration_days: int | None = Field(default=None, ge=0, le=15)
    operational_days: int | None = Field(default=None, ge=1, le=30)
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    daywise: bool | None = None
    inspection_rounds_per_day: int | None = Field(default=None, ge=1, le=20)
    before_inspection_enabled: bool | None = None
    after_inspection_enabled: bool | None = None
    is_active: bool | None = None


class CoachesReplace(StrictModel):
    coaches: list[CoachIn] = Field(min_length=1, max_length=40)

    _codes = field_validator("coaches")(_unique_codes)


class TrainOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    train_no: str
    name: str
    duration_days: int
    operational_days: int
    start_time: time | None
    end_time: time | None
    return_start_time: time | None
    return_end_time: time | None
    daywise: bool
    inspection_rounds_per_day: int
    before_inspection_enabled: bool
    after_inspection_enabled: bool
    is_active: bool
    coaches: list[CoachOut]
    updated_at: datetime
