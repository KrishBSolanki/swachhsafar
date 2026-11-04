"""Report parity dataset: builds a varied dataset through the real API, then records what a device would
download (the API responses the app ingests) together with the server's own report responses.

The device-side test (tests/unit/reportParity.test.js in the app) ingests those responses into SQLite and
checks that src/services/localReports.js produces the same reports. Run with
PARITY_EXPORT=<path to tests/fixtures/report-parity.json> to regenerate the shared fixture; without it the
test still builds the dataset and checks the server reports' internal consistency.
"""

import json
import os
import uuid
from datetime import timedelta

from sqlalchemy import update

from app.models import Question
from app.timeutil import today_ist
from tests.factories import now_iso, upload
from tests.test_feedback import ratings, verified_feedback

API = "/api/v1"


def _ok(r, status=(200, 201)):
    assert r.status_code in status, r.text
    return r.json()


def _all_pages(client, path, headers, **params):
    items, page = [], 1
    while True:
        body = _ok(client.get(f"{API}{path}", headers=headers, params={**params, "page": page, "page_size": 200}))
        items += body["items"]
        if len(items) >= body["total"]:
            return {**body, "items": items, "page": 1, "page_size": len(items) or 1}
        page += 1


def test_report_parity_dataset(world, fakes, db):
    c, H = world.client, world.h
    a = str(world.a.id)
    today = today_ist()

    # ---- masters: second train, complaint categories, inventory items ----
    train2 = world.create_train(train_no="12002")
    train3 = world.create_train(train_no="12003")
    j1 = world.journey
    j2 = world.create_journey(staff=["jan2"], train=train2)
    j3 = world.create_journey(staff=["jan"], train=train3)
    _ok(c.post(f"{API}/journeys/{j3['id']}/cancel", headers=H("manager"), json={"version": j3["version"], "reason": "Rake not available"}))
    dep = _ok(c.post(f"{API}/complaints/departments", headers=H("admin"), json={"division_id": a, "name": "Electrical"}))
    main = _ok(c.post(f"{API}/complaints/categories", headers=H("admin"), json={"division_id": a, "name": "Coach", "sla_hours": 48}))
    water = _ok(c.post(f"{API}/complaints/categories", headers=H("admin"), json={"division_id": a, "name": "Water", "sla_hours": 1,
                                                                               "default_department_id": dep["id"]}))
    phenyl = _ok(c.post(f"{API}/inventory/items", headers=H("admin"), json={"division_id": a, "name": "Phenyl", "unit": "ltr", "ideal_qty": 5}))
    soap = _ok(c.post(f"{API}/inventory/items", headers=H("admin"), json={"division_id": a, "name": "Soap", "unit": "nos", "ideal_qty": 10}))

    # ---- attendance: several staff, journeys and stages; one verified, one rejected ----
    def punch(journey, employee, stage, ts=None):
        return _ok(c.post(f"{API}/attendance", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=journey["id"], employee_id=str(world.users[employee].id), stage=stage,
            device_timestamp=ts or now_iso(), latitude=23.1, longitude=79.9,
            photo_media_id=upload(c, world.sup, world.a.id, "attendance_photo"))))
    att = [punch(j1, "jan", s) for s in (1, 2, 3)] + [punch(j1, "sup", 1),
                                                     # 00:05 IST today = the previous day in UTC: must count as today
                                                     punch(j2, "jan2", 1, ts=f"{today}T00:05:00+05:30")]
    _ok(c.post(f"{API}/attendance/{att[0]['id']}/review", headers=H("manager"), json={"status": "verified"}))
    _ok(c.post(f"{API}/attendance/{att[4]['id']}/review", headers=H("manager"), json={"status": "rejected", "remarks": "Blurred photo"}))

    # ---- inspections: two coaches, both phases, two rounds ----
    def inspect(journey, coach, rnd, phase):
        return _ok(c.post(f"{API}/inspections", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=journey["id"], coach_code=coach, day=1, round=rnd, phase=phase,
            device_timestamp=now_iso(), latitude=1, longitude=1,
            photo_media_id=upload(c, world.sup, world.a.id, "inspection_photo"))))
    ins = [inspect(j1, "B1", 1, "B"), inspect(j1, "B1", 1, "A"), inspect(j1, "S1", 1, "B"), inspect(j1, "B1", 2, "B"), inspect(j2, "B1", 1, "B")]
    _ok(c.post(f"{API}/inspections/{ins[0]['id']}/review", headers=H("manager"), json={"status": "verified"}))
    _ok(c.post(f"{API}/inspections/{ins[2]['id']}/review", headers=H("manager"), json={"status": "rejected"}))

    # ---- passenger feedback: two completed (with PSI weights), one left verified ----
    def complete(pnr, mobile, values):
        fb = verified_feedback(world, fakes, pnr=pnr, mobile=mobile)
        body = {"ratings": [{**r, "value": v} for r, v in zip(ratings(world), values)]}
        return _ok(c.post(f"{API}/feedback/passenger/{fb['id']}/complete", headers=H("sup"), json=body))
    complete("1111111111", "9111111111", [5, 3])
    complete("2222222222", "9222222222", [3, 1])
    verified_feedback(world, fakes, pnr="3333333333", mobile="9333333333")
    db.execute(update(Question).where(Question.bank_id == uuid.UUID(world.passenger_bank["id"])).values(psi_weight=2))
    db.commit()

    # ---- railway feedback: two entries, one verified ----
    def railway(rid, value):
        qs = world.railway_bank["questions"]
        return _ok(c.post(f"{API}/feedback/railway", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=j1["id"], railway_employee_id=rid, official_name="Insp. Rao", journey_day=1,
            device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
            ratings=[{"question_id": q["id"], "value": value} for q in qs if q["required"]])))
    r1 = railway("R1", 5)
    railway("R2", 2)
    _ok(c.post(f"{API}/feedback/railway/{r1['id']}/review", headers=H("manager"), json={"status": "verified"}))

    # ---- complaints: open, in process, completed ----
    def complain(category, journey=j1):
        return _ok(c.post(f"{API}/complaints", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), division_id=a, journey_id=journey["id"], coach_code="B1", category_id=category["id"],
            description="Fan in bay 3 not working", latitude=23.1, longitude=79.9, device_timestamp=now_iso())))
    complain(main)
    k2 = complain(water)
    k3 = complain(water, j2)
    _ok(c.post(f"{API}/complaints/{k2['id']}/transition", headers=H("manager"), json={"to_status": "in_process"}))
    _ok(c.post(f"{API}/complaints/{k3['id']}/transition", headers=H("manager"), json={"to_status": "completed", "remarks": "Fixed"}))

    # ---- inventory: issue / return across journeys and coaches ----
    def txn(journey, item, kind, qty, coach="B1"):
        return _ok(c.post(f"{API}/inventory/transactions", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=journey["id"], item_id=item["id"], coach_code=coach, txn_type=kind, quantity=qty)))
    txn(j1, phenyl, "issue", 10)
    txn(j1, phenyl, "return", 4)
    txn(j1, soap, "issue", 6, coach=None)
    txn(j2, phenyl, "issue", 2.5)

    # ---- what the device downloads (manager's view), then the server's reports ----
    hm = H("manager")
    journeys = [j1, j2, j3]
    downloads = [["GET", "/sync/changes", _ok(c.get(f"{API}/sync/changes", headers=hm))]]
    downloads += [["GET", "/users", _all_pages(c, "/users", hm, division_id=a)]]
    for j in journeys:
        downloads.append(["GET", f"/journeys/{j['id']}", _ok(c.get(f"{API}/journeys/{j['id']}", headers=hm))])
    for j in journeys:
        downloads.append(["GET", f"/attendance/journeys/{j['id']}/status", _ok(c.get(f"{API}/attendance/journeys/{j['id']}/status", headers=hm))])
        downloads.append(["GET", f"/inspections/journeys/{j['id']}/status", _ok(c.get(f"{API}/inspections/journeys/{j['id']}/status", headers=hm))])
        downloads.append(["GET", f"/inventory/journeys/{j['id']}/transactions", _all_pages(c, f"/inventory/journeys/{j['id']}/transactions", hm)])
    for path in ("/attendance", "/inspections", "/complaints", "/feedback/passenger", "/feedback/railway"):
        downloads.append(["GET", path, _all_pages(c, path, hm)])

    ranges = {
        "today": (today, today),
        "week": (today - timedelta(days=6), today),
        "future": (today + timedelta(days=5), today + timedelta(days=7)),
    }
    queries = []
    for name, (f, t) in ranges.items():
        base = {"date_from": str(f), "date_to": str(t)}
        queries += [
            ("/reports/attendance", {**base, "group_by": "employee"}), ("/reports/attendance", {**base, "group_by": "journey"}),
            ("/reports/inspections", {**base, "coach_wise": "false"}), ("/reports/inspections", {**base, "coach_wise": "true"}),
            ("/reports/feedback/passenger", base), ("/reports/feedback/railway", base), ("/reports/psi", base),
            ("/reports/complaints", base), ("/reports/inventory", base), ("/reports/inventory", {**base, "division_id": a}),
        ]
    reports = []
    for path, q in queries:
        r = c.get(f"{API}{path}", headers=hm, params=q)
        assert r.status_code == 200, (path, q, r.text)
        reports.append({"path": path, "query": q, "response": r.json()})

    # Server-side sanity of the dataset (so a broken fixture is caught here, not on the device side).
    by = {(x["path"], json.dumps(x["query"], sort_keys=True)): x["response"] for x in reports}
    t = {"date_from": str(today), "date_to": str(today)}
    k = lambda p, q: by[(p, json.dumps(q, sort_keys=True))]  # noqa: E731
    assert sum(r["records"] for r in k("/reports/attendance", {**t, "group_by": "employee"})) == 5
    assert {r["train_no"] for r in k("/reports/inspections", {**t, "coach_wise": "false"})} == {"12001", "12002"}  # cancelled excluded
    assert k("/reports/complaints", t)["total"] == 3
    assert k("/reports/feedback/passenger", t)["by_status"] == {"completed": 2, "verified": 1}
    assert k("/reports/feedback/railway", t)["by_status"] == {"verified": 1, "submitted": 1}
    assert k("/reports/attendance", {"date_from": str(today + timedelta(days=5)), "date_to": str(today + timedelta(days=7)), "group_by": "employee"}) == []

    out = os.environ.get("PARITY_EXPORT")
    if out:
        me = _ok(c.get(f"{API}/auth/me", headers=hm))
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"generated_at": now_iso(), "today": str(today), "me": me, "downloads": downloads, "reports": reports},
                      fh, indent=1, default=str)
