import uuid

from sqlalchemy import create_engine, inspect, select, update

from app.models import Question
from app.timeutil import today_ist
from tests.conftest import run_migrations
from tests.factories import now_iso, upload
from tests.test_feedback import ratings, verified_feedback

API = "/api/v1"


def _punch(world, employee, stage):
    return world.client.post(f"{API}/attendance", headers=world.h("sup"), json=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.users[employee].id), stage=stage,
        device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
        photo_media_id=upload(world.client, world.sup, world.a.id, "attendance_photo")))


def _complete(world, fakes, pnr, mobile, values):
    fb = verified_feedback(world, fakes, pnr=pnr, mobile=mobile)
    body = {"ratings": [{**r, "value": v} for r, v in zip(ratings(world), values)]}
    assert world.client.post(f"{API}/feedback/passenger/{fb['id']}/complete", headers=world.h("sup"), json=body).status_code == 200


def test_attendance_report_and_summary(world):
    for stage in range(1, 6):
        assert _punch(world, "jan", stage).status_code == 201
    _punch(world, "sup", 1)
    today = str(today_ist())
    rows = world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today},
                            headers=world.h("manager")).json()
    by_label = {r["label"]: r for r in rows}
    assert by_label["Jan (AAA-jan)"]["records"] == 5 and by_label["Jan (AAA-jan)"]["stages"] == {str(s): 1 for s in range(1, 6)}
    assert by_label["Sup (AAA-sup)"]["records"] == 1
    journey_rows = world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today, "group_by": "journey"},
                                    headers=world.h("manager")).json()
    assert len(journey_rows) == 1 and journey_rows[0]["records"] == 6
    summary = world.client.get(f"{API}/journeys/{world.journey['id']}/summary", headers=world.h("manager")).json()
    assert (summary["staff_allocated"], summary["attendance_records"], summary["staff_fully_attended"]) == (2, 6, 1)
    assert world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today},
                            headers=world.h("jan")).status_code == 403
    assert world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today, "division_id": str(world.a.id)},
                            headers=world.h("manager_b")).status_code == 403


def test_inspection_completion_report(world):
    for phase in ("B", "A"):
        world.client.post(f"{API}/inspections", headers=world.h("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=world.journey["id"], coach_code="B1", day=1, round=1, phase=phase,
            device_timestamp=now_iso(), latitude=1, longitude=1,
            photo_media_id=upload(world.client, world.sup, world.a.id, "inspection_photo")))
    today = str(today_ist())
    params = {"date_from": today, "date_to": today}
    [journey_row] = world.client.get(f"{API}/reports/inspections", params=params, headers=world.h("manager")).json()
    assert (journey_row["required"], journey_row["done"], journey_row["completion_pct"]) == (16, 2, 12.5)
    coach_rows = world.client.get(f"{API}/reports/inspections", params={**params, "coach_wise": True}, headers=world.h("manager")).json()
    assert {r["coach_code"]: r["done"] for r in coach_rows} == {"B1": 2, "S1": 0}


def test_feedback_report_and_psi(world, fakes, db):
    _complete(world, fakes, "1111111111", "9111111111", [5, 3])
    _complete(world, fakes, "2222222222", "9222222222", [3, 1])
    today = str(today_ist())
    params = {"date_from": today, "date_to": today}
    rep = world.client.get(f"{API}/reports/feedback/passenger", params=params, headers=world.h("manager")).json()
    assert rep["total"] == 2 and rep["by_status"] == {"completed": 2} and (rep["scale_min"], rep["scale_max"]) == (1, 5)
    assert [q["average"] for q in rep["questions"]] == [4.0, 2.0, None]

    r = world.client.get(f"{API}/reports/psi", params=params, headers=world.h("manager"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "psi_not_configured"
    db.execute(update(Question).where(Question.bank_id == uuid.UUID(world.passenger_bank["id"])).values(psi_weight=1))
    db.commit()
    [row] = world.client.get(f"{API}/reports/psi", params=params, headers=world.h("manager")).json()
    # (4-1)/4 = 0.75 and (2-1)/4 = 0.25 with equal weights; question 3 has no responses -> excluded
    assert row["responses"] == 2 and row["psi"] == 50.0


def test_dashboard_and_complaint_report(world):
    dash = world.client.get(f"{API}/dashboard/divisions/{world.a.id}", headers=world.h("manager")).json()
    assert dash["journeys_active"] == 1 and dash["complaints_open"] == 0
    assert world.client.get(f"{API}/dashboard/divisions/{world.a.id}", headers=world.h("sup")).status_code == 403
    _punch(world, "jan", 1)
    points = world.client.get(f"{API}/dashboard/divisions/{world.a.id}/map", params={"kind": "attendance"}, headers=world.h("manager")).json()
    assert len(points) == 1 and points[0]["stage"] == 1
    today = str(today_ist())
    rep = world.client.get(f"{API}/reports/complaints", params={"date_from": today, "date_to": today}, headers=world.h("manager")).json()
    assert rep == {"total": 0, "by_status": {}, "overdue": 0, "by_category": [], "avg_resolution_hours": None}


def test_create_journey_failure_rolls_back(world, db):
    from app.models import Journey, StaffAllocation

    before = (db.scalar(select(Journey.id).limit(1)), len(db.scalars(select(StaffAllocation)).all()))
    r = world.client.post(f"{API}/journeys", headers=world.h("manager"), json=dict(
        division_id=str(world.a.id), train_id=world.train["id"], journey_date=str(today_ist()),
        supervisor_id=str(world.sup.id), staff_ids=[str(world.jan2.id), str(world.manager.id)]))
    assert r.status_code == 422
    assert len(db.scalars(select(StaffAllocation)).all()) == before[1]


def test_migrations_downgrade_and_upgrade(pg):
    server, base = pg
    server.psql("DROP DATABASE IF EXISTS swachh_migrate WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_migrate;")
    url = f"{base}/swachh_migrate"
    run_migrations(url)
    engine = create_engine(url)
    assert "inspections" in inspect(engine).get_table_names()
    run_migrations(url, "base", "downgrade")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    run_migrations(url)
    with engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT count(*) FROM roles").scalar() == 6
    engine.dispose()
