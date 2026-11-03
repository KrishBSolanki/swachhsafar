import uuid
from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, MetaData, Numeric, Uuid, func
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def str_enum(enum_cls: type[Enum], length: int = 16) -> SAEnum:
    """Store a StrEnum as VARCHAR + CHECK constraint (no native PG enum, so migrations stay simple)."""
    return SAEnum(enum_cls, native_enum=False, length=length, values_callable=lambda e: [m.value for m in e])


class UUIDPk:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


class GeoPoint:
    latitude: Mapped[float] = mapped_column(Numeric(9, 6, asdecimal=False), nullable=False)
    longitude: Mapped[float] = mapped_column(Numeric(9, 6, asdecimal=False), nullable=False)
    gps_accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 2, asdecimal=False))


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False, index=True
    )
