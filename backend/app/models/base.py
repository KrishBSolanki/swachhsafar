import uuid
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import DateTime, MetaData, Numeric, TypeDecorator, Uuid, func
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql import functions
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class TZDateTime(TypeDecorator):
    """timestamptz on PostgreSQL (unchanged). SQLite has no time zone type: values are stored as UTC and read
    back as timezone-aware UTC datetimes, so the services compare and serialise them exactly as on PostgreSQL."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if isinstance(value, datetime) and dialect.name == "sqlite" and value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and dialect.name == "sqlite" and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


@compiles(functions.now, "sqlite")
def _sqlite_now(element, compiler, **kw):
    # UTC with milliseconds, in the format SQLAlchemy stores datetimes in (same as the migrations' defaults).
    return "strftime('%Y-%m-%d %H:%M:%f', 'now')"


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
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime(), server_default=func.now(), onupdate=func.now(), nullable=False, index=True
    )
