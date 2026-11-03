import uuid
from datetime import datetime

from pydantic import Field

from app.models import InventoryTxnType, Unit
from app.schemas.common import CoachCode, ReadModel, StrictModel


class ItemIn(StrictModel):
    division_id: uuid.UUID
    name: str = Field(min_length=2, max_length=100)
    unit: Unit
    ideal_qty: float = Field(ge=0, le=1_000_000)


class ItemUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    ideal_qty: float | None = Field(default=None, ge=0, le=1_000_000)
    is_active: bool | None = None


class ItemOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    name: str
    unit: Unit
    ideal_qty: float
    is_active: bool
    updated_at: datetime


class TxnIn(StrictModel):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    item_id: uuid.UUID
    coach_code: CoachCode | None = None
    txn_type: InventoryTxnType
    quantity: float = Field(gt=0, le=1_000_000)
    remarks: str | None = Field(default=None, max_length=300)


class TxnOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    item_id: uuid.UUID
    coach_code: str | None
    txn_type: InventoryTxnType
    quantity: float
    remarks: str | None
    created_by_id: uuid.UUID
    created_at: datetime


class BalanceRow(StrictModel):
    item_id: uuid.UUID
    item_name: str
    unit: Unit
    ideal_qty: float
    coach_code: str | None
    issued: float
    returned: float
    consumed: float
