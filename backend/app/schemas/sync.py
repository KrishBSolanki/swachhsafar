import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import StrictModel

OpType = Literal[
    "attendance.create",
    "inspection.create",
    "feedback.passenger.start",
    "feedback.railway.create",
    "complaint.create",
    "inventory.record",
]


class SyncOp(StrictModel):
    op_id: uuid.UUID = Field(description="Outbox operation id; the server stores the outcome under this id")
    type: OpType
    payload: dict[str, Any]


class SyncBatchIn(StrictModel):
    device_id: str = Field(min_length=4, max_length=64)
    operations: list[SyncOp] = Field(min_length=1, max_length=50)

    @field_validator("operations")
    @classmethod
    def _unique(cls, v: list[SyncOp]):
        if len({o.op_id for o in v}) != len(v):
            raise ValueError("op_id values must be unique within a batch")
        return v


class SyncResult(StrictModel):
    op_id: uuid.UUID
    type: str
    outcome: Literal["acknowledged", "conflict", "rejected", "retry"]
    http_status: int
    entity_id: uuid.UUID | None = None
    replayed: bool = False
    error: dict | None = None
    server_timestamp: datetime | None = None


class SyncBatchOut(StrictModel):
    server_time: datetime
    results: list[SyncResult]


class ChangesOut(StrictModel):
    cursor: datetime
    full: bool
    divisions: list[dict]
    policies: dict[str, dict]
    trains: list[dict]
    inventory_items: list[dict]
    question_banks: list[dict]
    complaint_departments: list[dict]
    complaint_categories: list[dict]
    journeys: list[dict]
