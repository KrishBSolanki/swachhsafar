"""The few SQL expressions that differ between PostgreSQL (production) and SQLite (local single-PC
deployment). Each helper returns the original PostgreSQL expression unchanged on PostgreSQL."""

from sqlalchemy import func
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session


def is_sqlite(db: Session) -> bool:
    return db.get_bind().dialect.name == "sqlite"


def insert_for(db: Session):
    """INSERT supporting ON CONFLICT DO UPDATE ... RETURNING (both dialects implement it)."""
    return sqlite.insert if is_sqlite(db) else postgresql.insert


def date_text(db: Session, col):
    """A date column as 'YYYY-MM-DD' text."""
    return func.strftime("%Y-%m-%d", col) if is_sqlite(db) else func.to_char(col, "YYYY-MM-DD")


def hours_between(db: Session, later, earlier):
    """(later - earlier) in hours, for timestamps."""
    if is_sqlite(db):
        return (func.julianday(later) - func.julianday(earlier)) * 24
    return func.extract("epoch", later - earlier) / 3600


def days_ago_date(db: Session, days: int):
    """The database's current date minus `days`, as a date."""
    return func.date("now", f"-{days} days") if is_sqlite(db) else func.current_date() - days


_SQLITE_UNIQUE_CODES = {2067, 1555}  # SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_PRIMARYKEY


def is_unique_violation(exc: Exception) -> bool:
    """A unique-constraint violation (PostgreSQL SQLSTATE 23505, or SQLite's UNIQUE / PRIMARY KEY codes)."""
    orig = getattr(exc, "orig", exc)
    if getattr(orig, "sqlstate", None) == "23505":
        return True
    code = getattr(orig, "sqlite_errorcode", None)
    return code in _SQLITE_UNIQUE_CODES or (code is None and str(orig).startswith("UNIQUE constraint failed"))
