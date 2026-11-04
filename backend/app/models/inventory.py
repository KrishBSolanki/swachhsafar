import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk, str_enum, TZDateTime


class Unit(StrEnum):
    NOS = "nos"
    LTR = "ltr"
    ML = "ml"
    KG = "kg"


class InventoryTxnType(StrEnum):
    ISSUE = "issue"
    RETURN = "return"


class InventoryItem(UUIDPk, Timestamps, Base):
    __tablename__ = "inventory_items"
    __table_args__ = (UniqueConstraint("division_id", "name"), CheckConstraint("ideal_qty >= 0", name="ideal_non_negative"))

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    unit: Mapped[Unit] = mapped_column(str_enum(Unit, 4), nullable=False)
    ideal_qty: Mapped[float] = mapped_column(Numeric(12, 3, asdecimal=False), nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class InventoryTransaction(Base):
    """Append-only ledger. Rows are never updated or deleted; corrections are new transactions."""

    __tablename__ = "inventory_transactions"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        Index("ix_inventory_txn_balance", "journey_id", "item_id", "coach_code"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False)
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    coach_code: Mapped[str | None] = mapped_column(String(10))
    txn_type: Mapped[InventoryTxnType] = mapped_column(str_enum(InventoryTxnType, 8), nullable=False)
    quantity: Mapped[float] = mapped_column(Numeric(12, 3, asdecimal=False), nullable=False)
    remarks: Mapped[str | None] = mapped_column(String(300))
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
