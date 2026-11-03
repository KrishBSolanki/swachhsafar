import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.timeutil import today_ist
from tests.factories import PDF, now_iso, upload

API = "/api/v1"


@pytest.fixture
def masters(world):
    c, h = world.client, world.h("admin")
    dep = c.post(f"{API}/complaints/departments", headers=h, json={"division_id": str(world.a.id), "name": "Electrical"}).json()
    main = c.post(f"{API}/complaints/categories", headers=h, json={"division_id": str(world.a.id), "name": "Coach", "sla_hours": 48}).json()
    sub = c.post(f"{API}/complaints/categories", headers=h, json={"division_id": str(world.a.id), "name": "Fan not working",
                                                                  "parent_id": main["id"], "sla_hours": 6,
                                                                  "default_department_id": dep["id"]}).json()
    return dep, main, sub


def complain(world, main, sub=None, by="sup", **extra):
    body = dict(id=str(uuid.uuid4()), division_id=str(world.a.id), journey_id=world.journey["id"], coach_code="B1",
                category_id=main["id"], subcategory_id=sub and sub["id"], description="Fan in bay 3 not working",
                latitude=23.1, longitude=79.9, device_timestamp=now_iso(), **extra)
    return world.client.post(f"{API}/complaints", headers=world.h(by), json=body)


def test_create_with_sla_number_and_attachments(world, masters):
    dep, main, sub = masters
    files = [upload(world.client, world.sup, world.a.id, "complaint_attachment"),
             upload(world.client, world.sup, world.a.id, "complaint_attachment", data=PDF, content_type="application/pdf")]
    r = complain(world, main, sub, attachment_ids=files)
    assert r.status_code == 201, r.text
    c = r.json()
    year = today_ist().year
    assert c["complaint_no"] == f"AAA-{year}-000001"
    assert (c["sla_hours"], c["department_id"], c["coach_class"], c["status"]) == (6, dep["id"], "AC", "created")
    assert sorted(c["attachment_ids"]) == sorted(files)
    assert [h["to_status"] for h in c["history"]] == ["created"]
    assert complain(world, main, sub).json()["complaint_no"] == f"AAA-{year}-000002"


def test_subcategory_required_and_must_match(world, masters):
    _, main, sub = masters
    other = world.client.post(f"{API}/complaints/categories", headers=world.h("admin"),
                              json={"division_id": str(world.a.id), "name": "Water"}).json()
    assert complain(world, main).json()["error"]["code"] == "subcategory_required"
    assert complain(world, other, sub).json()["error"]["code"] == "invalid_category"
    r = complain(world, other)
    assert r.status_code == 201 and r.json()["sla_hours"] == 72  # policy default


def test_transitions_and_history(world, masters):
    _, main, sub = masters
    cid = complain(world, main, sub).json()["id"]
    url = f"{API}/complaints/{cid}/transition"
    assert world.client.post(url, headers=world.h("sup"), json={"to_status": "in_process"}).status_code == 403
    assert world.client.post(url, headers=world.h("manager"), json={"to_status": "in_process"}).status_code == 200
    r = world.client.post(url, headers=world.h("manager"), json={"to_status": "forwarded", "forward_to_user_id": str(world.jan.id)})
    assert r.status_code == 422  # janitors cannot handle complaints
    r = world.client.post(url, headers=world.h("manager"), json={"to_status": "forwarded", "forward_to_user_id": str(world.admin.id)})
    assert r.status_code == 200 and r.json()["assigned_to_id"] == str(world.admin.id)
    assert world.client.post(url, headers=world.h("admin"), json={"to_status": "completed"}).status_code == 422
    r = world.client.post(url, headers=world.h("admin"), json={"to_status": "completed", "remarks": "Fan replaced"})
    body = r.json()
    assert body["status"] == "completed" and body["closed_at"] and body["resolution_remarks"] == "Fan replaced"
    assert [h["to_status"] for h in body["history"]] == ["created", "in_process", "forwarded", "completed"]
    r = world.client.post(url, headers=world.h("admin"), json={"to_status": "in_process"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_transition"


def test_complaint_history_is_append_only(world, masters, db):
    _, main, sub = masters
    complain(world, main, sub)
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE complaint_history SET remarks = 'tampered'"))
    db.rollback()


def test_complaint_visibility(world, masters):
    _, main, sub = masters
    cid = complain(world, main, sub).json()["id"]
    assert world.client.get(f"{API}/complaints/{cid}", headers=world.h("manager_b")).status_code == 404
    assert world.client.get(f"{API}/complaints?overdue=false", headers=world.h("manager")).json()["total"] == 1


# ---- inventory ---------------------------------------------------------------------------------------------


@pytest.fixture
def item(world):
    r = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                          json={"division_id": str(world.a.id), "name": "Phenyl", "unit": "ltr", "ideal_qty": 5})
    assert r.status_code == 201
    return r.json()


def txn(world, item, kind, qty, coach="B1", by="sup", **extra):
    return world.client.post(f"{API}/inventory/transactions", headers=world.h(by), json=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], item_id=item["id"], coach_code=coach, txn_type=kind, quantity=qty, **extra))


def test_issue_return_and_balance(world, item):
    assert txn(world, item, "issue", 4).status_code == 201
    assert txn(world, item, "issue", 1.5).status_code == 201
    assert txn(world, item, "return", 2).status_code == 201
    r = txn(world, item, "return", 4)
    assert r.status_code == 422 and r.json()["error"]["details"]["outstanding"] == 3.5
    r = txn(world, item, "return", 1, coach="S1")
    assert r.status_code == 422  # nothing issued to S1
    bal = world.client.get(f"{API}/inventory/journeys/{world.journey['id']}/balance", headers=world.h("manager")).json()
    assert bal == [dict(item_id=item["id"], item_name="Phenyl", unit="ltr", ideal_qty=5.0, coach_code="B1",
                        issued=5.5, returned=2.0, consumed=3.5)]
    ledger = world.client.get(f"{API}/inventory/journeys/{world.journey['id']}/transactions", headers=world.h("manager")).json()
    assert [t["txn_type"] for t in ledger["items"]] == ["issue", "issue", "return"]


def test_ledger_is_immutable(world, item, db):
    txn(world, item, "issue", 1)
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE inventory_transactions SET quantity = 100"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM inventory_transactions"))
    db.rollback()


def test_inventory_authorization(world, item):
    assert txn(world, item, "issue", 1, by="jan").status_code == 403
    assert txn(world, item, "issue", 1, by="sup2").status_code == 404
    assert txn(world, item, "issue", 1, coach="ZZ").status_code == 422
    r = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                          json={"division_id": str(world.a.id), "name": "Phenyl", "unit": "ltr", "ideal_qty": 5})
    assert r.status_code == 409
