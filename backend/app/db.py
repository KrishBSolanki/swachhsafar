from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

# SQLite (the local single-PC deployment). PostgreSQL serialises the read-check-write critical sections
# (feedback limits, inventory balances, complaint numbers, OTP attempts) with SELECT ... FOR UPDATE, which
# SQLite ignores. Instead, a transaction that may write starts with BEGIN IMMEDIATE: it takes the database
# write lock up front, so those sections run one at a time and a concurrent writer waits (busy_timeout)
# instead of reading stale data or failing half-way. Read-only work (GET requests) uses a deferred
# transaction, which in WAL mode reads the last committed state without blocking or being blocked.
SQLITE_BUSY_TIMEOUT_MS = 30_000
_write_intent: ContextVar[bool] = ContextVar("sqlite_write_intent", default=False)


@contextmanager
def write_intent(enabled: bool = True):
    """SQLite transactions begun inside take the write lock immediately (no effect on PostgreSQL)."""
    token = _write_intent.set(enabled)
    try:
        yield
    finally:
        _write_intent.reset(token)


class WriteIntentMiddleware:
    """ASGI: requests that can change data (anything but GET/HEAD/OPTIONS) run with write intent."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        with write_intent():
            return await self.app(scope, receive, send)


def _configure_sqlite(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _record):
        # Autocommit at the driver level: SQLAlchemy's "begin" event below issues the transaction itself.
        dbapi_conn.isolation_level = None
        cur = dbapi_conn.cursor()
        for pragma in ("foreign_keys = ON", "journal_mode = WAL", f"busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}",
                       "synchronous = FULL", "recursive_triggers = OFF"):
            cur.execute(f"PRAGMA {pragma}")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE" if _write_intent.get() else "BEGIN")


def make_engine(url: str) -> Engine:
    if make_url(url).get_backend_name() == "sqlite":
        engine = create_engine(url, future=True, connect_args={"check_same_thread": False, "timeout": SQLITE_BUSY_TIMEOUT_MS / 1000})
        _configure_sqlite(engine)
        return engine
    return create_engine(url, pool_pre_ping=True, future=True)


@lru_cache
def get_engine() -> Engine:
    return make_engine(get_settings().database_url)


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """One session per request. Services commit explicitly; anything left open is rolled back."""
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
