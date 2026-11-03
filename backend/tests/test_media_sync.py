import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import Attendance, SyncOperation
from tests.factories import PNG, now_iso, upload

API = "/api/v1"


def init(world, data, kind="attendance_photo", content_type="image/png", size=None, sha=None, by="sup"):
    media_id = str(uuid.uuid4())
    r = world.client.post(f"{API}/media", headers=world.h(by), json=dict(
        id=media_id, division_id=str(world.a.id), kind=kind, content_type=content_type,
        size_bytes=size or len(data), sha256=sha or hashlib.sha256(data).hexdigest()))
    return media_id, r


def test_upload_validates_content(world):
    media_id, r = init(world, PNG)
    assert r.status_code == 201 and r.json()["status"] == "pending"
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    assert r.status_code == 200 and (r.json()["status"], r.json()["content_type"]) == ("uploaded", "image/png")
    link = world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager")).json()
    assert world.client.get(link["url"], headers=world.h("manager")).content == PNG
    assert world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager_b")).status_code == 403


def test_spoofed_type_checksum_and_size_rejected(world):
    fake = b"<?php system($_GET['c']); ?>" + bytes(50)
    media_id, _ = init(world, fake)
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=fake)
    assert r.status_code == 422 and "not an allowed type" in r.json()["error"]["message"]
    media_id, _ = init(world, PNG, sha="a" * 64)
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG).json()["error"]["message"] == "Checksum mismatch"
    _, r = init(world, PNG, size=9 * 1024 * 1024)
    assert r.status_code == 422 and r.json()["error"]["code"] == "file_too_large"
    _, r = init(world, PNG, content_type="application/x-msdownload")
    assert r.json()["error"]["code"] == "file_type_rejected"
    media_id, _ = init(world, PNG)
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("jan"), content=PNG).status_code == 404


def test_upload_is_idempotent(world):
    media_id = upload(world.client, world.sup, world.a.id, "attendance_photo")
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    assert r.status_code == 200 and r.json()["status"] == "uploaded"


def _attendance_op(world, media_id, stage=1, employee="jan", record_id=None):
    return dict(op_id=str(uuid.uuid4()), type="attendance.create", payload=dict(
        id=record_id or str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.users[employee].id), stage=stage,
        device_timestamp=now_iso(), latitude=23.1, longitude=79.9, photo_media_id=media_id))


def batch(world, ops, by="sup"):
    r = world.client.post(f"{API}/sync/batch", headers=world.h(by), json={"device_id": "device-001", "operations": ops})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_batch_outcomes(world):
    media_id, _ = init(world, PNG)  # registered but bytes not yet uploaded
    pending_op = _attendance_op(world, media_id)
    bad_op = dict(op_id=str(uuid.uuid4()), type="attendance.create", payload={"id": str(uuid.uuid4()), "stage": 9})
    order_op = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"), stage=3, employee="sup")
    res = batch(world, [pending_op, bad_op, order_op])
    assert [r["outcome"] for r in res] == ["retry", "rejected", "rejected"]
    assert res[0]["error"]["code"] == "media_pending" and res[2]["error"]["code"] == "stage_order"

    world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    res = batch(world, [pending_op])
    assert res[0]["outcome"] == "acknowledged" and res[0]["http_status"] == 201

    # lost acknowledgement: same op again returns the stored outcome without a second record
    again = batch(world, [pending_op])
    assert again[0]["outcome"] == "acknowledged" and again[0]["replayed"] is True
    assert world.db.scalar(select(func.count()).select_from(Attendance)) == 1
    assert world.client.get(f"{API}/sync/operations/{pending_op['op_id']}", headers=world.h("sup")).json()["outcome"] == "acknowledged"
    record = world.db.scalar(select(Attendance))
    assert str(record.sync_op_id) == pending_op["op_id"]


def test_duplicate_from_second_device_is_conflict(world):
    first = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    second = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    res = batch(world, [first, second])
    assert [r["outcome"] for r in res] == ["acknowledged", "conflict"]
    assert res[1]["error"]["code"] == "duplicate_attendance"
    assert world.db.scalar(select(func.count()).select_from(SyncOperation)) == 2


def test_op_id_cannot_be_hijacked(world):
    op = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    batch(world, [op])
    res = batch(world, [op], by="jan")
    assert res[0]["outcome"] == "rejected" and res[0]["error"]["code"] == "op_id_reused"
    assert world.client.get(f"{API}/sync/operations/{op['op_id']}", headers=world.h("jan")).status_code == 404


def test_batch_handles_other_types(world):
    item = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                             json={"division_id": str(world.a.id), "name": "Soap", "unit": "nos", "ideal_qty": 10}).json()
    ops = [dict(op_id=str(uuid.uuid4()), type="inventory.record", payload=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], item_id=item["id"], txn_type="issue", quantity=3))]
    assert batch(world, ops)[0]["outcome"] == "acknowledged"


def test_incremental_changes(world):
    full = world.client.get(f"{API}/sync/changes", headers=world.h("sup")).json()
    assert full["full"] is True
    assert [t["train_no"] for t in full["trains"]] == ["12001"]
    assert [j["id"] for j in full["journeys"]] == [world.journey["id"]]
    assert str(world.a.id) in full["policies"] and len(full["question_banks"]) == 2
    jan_view = world.client.get(f"{API}/sync/changes", headers=world.h("jan2")).json()
    assert jan_view["journeys"] == []

    future = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    later = world.client.get(f"{API}/sync/changes", params={"since": future}, headers=world.h("sup")).json()
    assert later["full"] is False and later["trains"] == [] and later["journeys"] == []
    since = full["cursor"]
    world.client.post(f"/api/v1/staff-allocation/{world.journey['id']}", headers=world.h("manager"),
                      json={"user_ids": [str(world.jan2.id)]})
    delta = world.client.get(f"{API}/sync/changes", params={"since": since}, headers=world.h("jan2")).json()
    assert [j["id"] for j in delta["journeys"]] == [world.journey["id"]]
