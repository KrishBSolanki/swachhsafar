import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime
from app.models.org import JSONType


class SyncOperation(Base):
    """Server-side acknowledgement record for a device outbox operation (keyed by the device op id)."""

    __tablename__ = "sync_operations"

    op_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    op_type: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    outcome: Mapped[str] = mapped_column(String(16), nullable=False)
    http_status: Mapped[int] = mapped_column(Integer, nullable=False)
    result: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    received_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
