"""SQLite-specific guarantees of the local single-PC deployment (run with TEST_DB=sqlite; skipped on PostgreSQL).

Connection pragmas, migrations (fresh, repeated and concurrent), the append-only triggers, the partial and
NULLS-NOT-DISTINCT unique rules, timezone round trips, concurrent API writes under the database write lock,
and the idempotent bootstrap CLI."""

import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import SQLITE
from tests.factories import now_iso

pytestmark = pytest.mark.skipif(not SQLITE, reason="SQLite deployment tests (TEST_DB=sqlite)")
API = "/api/v1"
BACKEND = Path(__file__).resolve().parents[1]


def test_connection_pragmas(engine):
    with engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        assert conn.exec_driver_sql("PRAGMA journal_mode").scalar() == "wal"
        assert conn.exec_driver_sql("PRAGMA busy_timeout").scalar() == 30_000
        assert conn.exec_driver_sql("PRAGMA synchronous").scalar() == 2  # FULL


def _upgrade(db_file: Path):
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_file.as_posix()}", "PYTHONPATH": str(BACKEND)}
    return subprocess.Popen([sys.executable, "-m", "alembic", "-c", str(BACKEND / "alembic.ini"), "upgrade", "head"],
                            cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def test_migrations_fresh_repeated_and_concurrent(tmp_path):
    import sqlite3

    db_file = tmp_path / "concurrent.db"
    procs = [_upgrade(db_file) for _ in range(3)]  # three initialisations racing on a new file
    outs = [p.communicate(timeout=180)[0] for p in procs]
    assert [p.returncode for p in procs] == [0, 0, 0], outs
    again = _upgrade(db_file)
    assert again.wait(timeout=180) == 0
    con = sqlite3.connect(db_file)
    assert con.execute("SELECT version_num FROM alembic_version").fetchall() == [("0002",)]
    assert con.execute("SELECT count(*) FROM roles").fetchone() == (6,)  # reference data applied exactly once
    assert con.execute("SELECT count(*) FROM permissions").fetchone()[0] > 0
    assert con.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    con.close()


def test_append_only_tables(world, db):
    item = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                             json={"division_id": str(world.a.id), "name": "Phenyl", "unit": "ltr", "ideal_qty": 5}).json()
    r = world.client.post(f"{API}/inventory/transactions", headers=world.h("sup"), json=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], item_id=item["id"], coach_code="B1", txn_type="issue", quantity=2))
    assert r.status_code == 201, r.text
    for sql in ("UPDATE inventory_transactions SET quantity = 99", "DELETE FROM inventory_transactions", "DELETE FROM audit_logs"):
        with pytest.raises(IntegrityError, match="append-only"):
            db.execute(text(sql))
        db.rollback()


def test_unique_rules_match_postgresql(world, db):
    # NULLS NOT DISTINCT: one global grant per (role, permission).
    with pytest.raises(IntegrityError):
        db.execute(text("INSERT INTO role_permissions (id, role_id, permission_code, division_id, effect) "
                        "SELECT :id, role_id, permission_code, NULL, effect FROM role_permissions WHERE division_id IS NULL LIMIT 1"),
                   {"id": uuid.uuid4().hex})
    db.rollback()
    # Partial unique index: e-mail unique (case-insensitively) among live users only.
    from app.models import RoleId, User, UserStatus

    sup = world.users["sup"]
    sup.email = "sup@example.com"
    db.merge(sup)
    db.commit()

    def other(status):
        return User(emp_id=f"X-{uuid.uuid4().hex[:6]}", name="Other", role_id=int(RoleId.JANITOR), division_id=world.a.id,
                    email="SUP@example.com", status=status)

    db.add(other(UserStatus.ACTIVE))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(other(UserStatus.DELETED))  # a deleted user may keep an old e-mail
    db.commit()


def test_timestamps_are_timezone_aware_utc(world, db):
    from app.models import Journey

    j = db.get(Journey, uuid.UUID(world.journey["id"]))
    assert j.created_at.tzinfo is not None and j.created_at.utcoffset() == timedelta(0)
    assert abs(datetime.now(timezone.utc) - j.created_at) < timedelta(minutes=5)


def test_concurrent_api_writes_serialise_without_lock_errors(world):
    """Writers queue on the database lock: per-journey limits and complaint numbering stay exact."""
    c, h = world.client, world.h
    qs = world.railway_bank["questions"]

    def railway(i):
        return c.post(f"{API}/feedback/railway", headers=h("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=world.journey["id"], railway_employee_id=f"R{i}", official_name="Insp. Rao",
            journey_day=1, device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
            ratings=[{"question_id": q["id"], "value": 4} for q in qs if q["required"]])).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = sorted(pool.map(railway, range(6)))
    assert codes == [201, 201, 409, 409, 409, 409], codes  # policy: at most 2 per journey, never more

    main = c.post(f"{API}/complaints/categories", headers=h("admin"), json={"division_id": str(world.a.id), "name": "Water"}).json()

    def complain(_):
        r = c.post(f"{API}/complaints", headers=h("sup"), json=dict(
            id=str(uuid.uuid4()), division_id=str(world.a.id), journey_id=world.journey["id"], coach_code="B1",
            category_id=main["id"], description="No water in coach B1", device_timestamp=now_iso()))
        assert r.status_code == 201, r.text
        return r.json()["complaint_no"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        numbers = list(pool.map(complain, range(8)))
    assert sorted(int(n.rsplit("-", 1)[1]) for n in numbers) == list(range(1, 9))  # unique, gap-free


def test_concurrent_sync_batch_is_delivered_once(world):
    op = {"op_id": str(uuid.uuid4()), "type": "inventory.record", "payload": None}
    item = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                             json={"division_id": str(world.a.id), "name": "Soap", "unit": "nos", "ideal_qty": 5}).json()
    op["payload"] = dict(id=str(uuid.uuid4()), journey_id=world.journey["id"], item_id=item["id"], coach_code="B1", txn_type="issue", quantity=3)
    body = {"device_id": "pwa-test", "operations": [op]}

    def send(_):
        return world.client.post(f"{API}/sync/batch", headers=world.h("sup"), json=body).json()["results"][0]

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(send, range(5)))
    assert all(r["outcome"] == "acknowledged" for r in results), results
    ledger = world.client.get(f"{API}/inventory/journeys/{world.journey['id']}/transactions", headers=world.h("manager")).json()
    assert ledger["total"] == 1


def test_bootstrap_cli_is_idempotent(engine, db, capsys):
    from app.cli import main
    from app.models import Division, User

    assert main(["create-division", "--code", "jbp", "--name", "Jabalpur Division"]) == 0
    assert main(["create-division", "--code", "JBP", "--name", "Jabalpur Division"]) == 0
    assert main(["create-division", "--code", "JBP", "--name", "Other name"]) == 2
    args = ["create-superadmin", "--division-code", "JBP", "--emp-id", "SA001", "--name", "Admin", "--email", "Admin@Example.com"]
    assert main(args) == 0
    assert main(args) == 0
    assert main([*args, "--firebase-uid", "uid-1"]) == 0  # links an existing Firebase identity once
    assert main([*args, "--firebase-uid", "uid-2"]) == 2  # never re-linked to another account
    assert main([*args[:-2], "--email", "someone@example.com"]) == 2  # emp_id belongs to that user
    db.expire_all()
    assert db.query(Division).filter_by(code="JBP").count() == 1
    users = db.query(User).filter_by(emp_id="SA001").all()
    assert len(users) == 1 and users[0].firebase_uid == "uid-1" and users[0].email == "admin@example.com"
