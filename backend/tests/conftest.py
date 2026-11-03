"""Tests run against a real PostgreSQL 16 (embedded via pgserver) migrated with Alembic. External services are
replaced by in-process fakes: Firebase token verification, SMS gateway, PNR API. Storage uses the local backend."""

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


_SERVER, _BASE_URI = _start_postgres()
os.environ.update(
    DATABASE_URL=f"{_BASE_URI}/swachh_test",
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
    return _SERVER, _BASE_URI


@pytest.fixture(scope="session")
def engine():
    from app.config import get_settings
    from app.db import get_engine

    get_settings.cache_clear()
    run_migrations(os.environ["DATABASE_URL"])
    shutil.rmtree(_MEDIA, ignore_errors=True)
    yield get_engine()
    get_engine().dispose()


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
