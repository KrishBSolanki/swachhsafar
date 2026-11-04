"""Tests run against a real PostgreSQL 16 (embedded via pgserver) migrated with Alembic. External services are
replaced by in-process fakes: Firebase token verification, SMS gateway, PNR API. Storage uses the local backend.

TEST_DB=sqlite runs the same suite against SQLite (the local single-PC deployment): the database is migrated
once into a template file with Alembic, and every test starts from a fresh copy of it."""

import os
import shutil
import tempfile
from pathlib import Path

import pytest

_ROOT = Path(tempfile.gettempdir()) / "swachh_safar_backend_tests"
_PGDATA = _ROOT / "pgdata"
_MEDIA = _ROOT / "media"


def _start_postgres():
    import pgserver

    _ROOT.mkdir(parents=True, exist_ok=True)
    server = pgserver.get_server(str(_PGDATA), cleanup_mode="stop")
    server.psql("DROP DATABASE IF EXISTS swachh_test WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_test;")
    base = server.get_uri().rsplit("/", 1)[0].replace("postgresql://", "postgresql+psycopg://")
    return server, base


SQLITE = os.environ.get("TEST_DB") == "sqlite"
_SQLITE_DB = _ROOT / "sqlite" / "swachh_test.db"
_SQLITE_TEMPLATE = _ROOT / "sqlite" / "template.db"

if SQLITE:
    _SERVER, _BASE_URI = None, None
    _DATABASE_URL = f"sqlite:///{_SQLITE_DB.as_posix()}"
else:
    _SERVER, _BASE_URI = _start_postgres()
    _DATABASE_URL = f"{_BASE_URI}/swachh_test"
os.environ.update(
    DATABASE_URL=_DATABASE_URL,
    ENVIRONMENT="test",
    OTP_PEPPER="test-pepper-" + "x" * 40,
    STORAGE_BACKEND="local",
    LOCAL_MEDIA_DIR=str(_MEDIA),
    OTP_RESEND_COOLDOWN_SECONDS="0",
)


def run_migrations(url: str, target: str = "head", direction: str = "upgrade") -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    cfg.attributes["database_url"] = url
    getattr(command, direction)(cfg, target)


@pytest.fixture(scope="session")
def pg():
    if SQLITE:
        pytest.skip("PostgreSQL-specific test (TEST_DB=sqlite)")
    return _SERVER, _BASE_URI


def _sqlite_files(path: Path) -> list[Path]:
    return [path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")]


@pytest.fixture(scope="session")
def engine():
    from app.config import get_settings
    from app.db import get_engine

    get_settings.cache_clear()
    if SQLITE:
        _SQLITE_DB.parent.mkdir(parents=True, exist_ok=True)
        for f in _sqlite_files(_SQLITE_TEMPLATE) + _sqlite_files(_SQLITE_DB):
            f.unlink(missing_ok=True)
        run_migrations(f"sqlite:///{_SQLITE_TEMPLATE.as_posix()}")
        _checkpoint(_SQLITE_TEMPLATE)
        shutil.copyfile(_SQLITE_TEMPLATE, _SQLITE_DB)
    else:
        run_migrations(os.environ["DATABASE_URL"])
    shutil.rmtree(_MEDIA, ignore_errors=True)
    yield get_engine()
    get_engine().dispose()


def _checkpoint(path: Path) -> None:
    """Fold the WAL into the main file so the template is a single self-contained file."""
    import sqlite3

    con = sqlite3.connect(path)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("PRAGMA journal_mode = DELETE")
    con.close()


KEEP = {"roles", "permissions", "alembic_version"}


@pytest.fixture(scope="session")
def seeded_grants(engine):
    from sqlalchemy import text

    with engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(text("SELECT id, role_id, permission_code, effect FROM role_permissions"))]


@pytest.fixture(autouse=True)
def clean_db(engine, seeded_grants):
    """role_permissions references divisions, so it is truncated too and the migration's global grants restored."""
    from sqlalchemy import text

    from app.models import Base
    from app.security.ratelimit import limiter

    if SQLITE:
        # A fresh copy of the migrated template (the append-only triggers forbid DELETE, as TRUNCATE-less
        # SQLite would need): close every pooled connection first so no handle points at the old file.
        engine.dispose()
        for f in _sqlite_files(_SQLITE_DB):
            f.unlink(missing_ok=True)
        shutil.copyfile(_SQLITE_TEMPLATE, _SQLITE_DB)
        limiter.reset()
        yield
        engine.dispose()
        return
    tables = [t.name for t in Base.metadata.sorted_tables if t.name not in KEEP]
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY"))
        conn.execute(text("INSERT INTO role_permissions (id, role_id, permission_code, effect) "
                          "VALUES (:id, :role_id, :permission_code, :effect)"), seeded_grants)
    limiter.reset()
    yield


@pytest.fixture
def db(engine):
    from app.db import get_sessionmaker

    session = get_sessionmaker()()
    yield session
    session.rollback()
    session.close()


@pytest.fixture
def fakes():
    from tests.factories import FakePnr, FakeSms, FakeVerifier

    return FakeVerifier(), FakeSms(), FakePnr()


@pytest.fixture
def client(engine, fakes):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.providers.external import get_pnr_provider, get_sms_provider
    from app.providers.storage import LocalStorage, get_storage
    from app.security.tokens import get_token_verifier

    verifier, sms, pnr = fakes
    storage = LocalStorage(str(_MEDIA))
    app.dependency_overrides.update({
        get_token_verifier: lambda: verifier,
        get_sms_provider: lambda: sms,
        get_pnr_provider: lambda: pnr,
        get_storage: lambda: storage,
    })
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def world(db, client):
    """Two divisions with a full cast of users, a train and an active journey in division A."""
    from tests.factories import World

    return World.build(db, client)
