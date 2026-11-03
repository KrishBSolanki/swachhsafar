from datetime import datetime
from typing import Annotated, Generic, TypeVar

from fastapi import Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

T = TypeVar("T")


class StrictModel(BaseModel):
    """Request bodies reject unknown fields, which blocks mass assignment of server-owned columns."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ReadModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class PageParams:
    def __init__(
        self,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
    ):
        self.page = page
        self.page_size = page_size

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def _aware(v: datetime) -> datetime:
    if v.tzinfo is None:
        raise ValueError("timestamp must include a timezone offset")
    return v


AwareDatetime = Annotated[datetime, AfterValidator(_aware)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
Accuracy = Annotated[float, Field(ge=0, le=10000)]
Mobile = Annotated[str, Field(pattern=r"^[6-9][0-9]{9}$")]
CoachCode = Annotated[str, Field(min_length=1, max_length=10, pattern=r"^[A-Z0-9 ]+$")]


class Captured(StrictModel):
    """Fields every device-captured record carries."""

    device_timestamp: AwareDatetime
    latitude: Latitude
    longitude: Longitude
    gps_accuracy_m: Accuracy | None = None
