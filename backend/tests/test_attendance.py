import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import Attendance
from tests.factories import now_iso, upload

API = "/api/v1/attendance"


def punch(world, employee, stage, by="sup", photo=True, record_id=None, ts=None, **extra):
    submitter = world.users[by]
    body = dict(id=record_id or str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.users[employee].id),
                stage=stage, device_timestamp=ts or now_iso(), latitude=23.1815, longitude=79.9864, gps_accuracy_m=12.5, **extra)
    if photo:
        body["photo_media_id"] = upload(world.client, submitter, world.a.id, "attendance_photo")
    return world.client.post(API, headers=world.h(by), json=body), body


def test_sequential_stages_and_duplicates(world):
    r, _ = punch(world, "jan", 2)
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_order"
    for stage in (1, 2, 3):
        r, _ = punch(world, "jan", stage)
        assert r.status_code == 201, r.text
    r, _ = punch(world, "jan", 3)
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_attendance"
    r, _ = punch(world, "jan", 5)
    assert r.status_code == 422
    rec = r.json()
    status = world.client.get(f"{API}/journeys/{world.journey['id']}/status", headers=world.h("sup")).json()
    jan = next(s for s in status if s["employee_id"] == str(world.jan.id))
    assert [c["status"] for c in jan["stages"]] == ["taken", "taken", "taken", "next", "locked"]
    assert rec["error"]["details"]["recorded_stages"] == [1, 2, 3]


def test_record_contents(world):
    r, body = punch(world, "jan", 1)
    rec = r.json()
    assert rec["created_by_id"] == str(world.sup.id) and rec["employee_id"] == str(world.jan.id)
    assert rec["division_id"] == str(world.a.id) and rec["verification_status"] == "submitted"
    assert rec["gps_accuracy_m"] == 12.5 and rec["photo_media_id"] == body["photo_media_id"]
    assert rec["server_timestamp"] and rec["device_timestamp"]


def test_only_allocated_staff(world):
    r, _ = punch(world, "jan2", 1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_allocated"


def test_janitor_can_only_punch_self(world):
    world.client.post(f"/api/v1/staff-allocation/{world.journey['id']}", headers=world.h("manager"),
                      json={"user_ids": [str(world.jan2.id)]})
    r, _ = punch(world, "jan2", 1, by="jan")
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_authorized_for_employee"
    r, _ = punch(world, "jan", 1, by="jan")
    assert r.status_code == 201


def test_other_division_cannot_submit(world):
    r, _ = punch(world, "jan", 1, by="sup_b", photo=False)
    assert r.status_code == 404


def test_idempotent_replay_and_mismatch(world):
    r1, body = punch(world, "jan", 1)
    r2 = world.client.post(API, headers=world.h("sup"), json=body)
    assert r2.status_code == 200 and r2.headers["Idempotent-Replayed"] == "true" and r2.json()["id"] == r1.json()["id"]
    r3 = world.client.post(API, headers=world.h("sup"), json={**body, "latitude": 10.0})
    assert r3.status_code == 409 and r3.json()["error"]["code"] == "idempotency_mismatch"
    assert world.db.scalar(select(func.count()).select_from(Attendance)) == 1


def test_photo_required_and_must_be_uploaded(world):
    r, _ = punch(world, "jan", 1, photo=False)
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_required"
    media_id = str(uuid.uuid4())
    world.client.post("/api/v1/media", headers=world.h("sup"), json=dict(
        id=media_id, division_id=str(world.a.id), kind="attendance_photo", content_type="image/png", size_bytes=10, sha256="0" * 64))
    r, _ = punch(world, "jan", 1, photo=False, photo_media_id=media_id)
    assert r.status_code == 409 and r.json()["error"]["code"] == "media_pending"
    other = upload(world.client, world.sup, world.a.id, "inspection_photo")
    r, _ = punch(world, "jan", 1, photo=False, photo_media_id=other)
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_mismatch"


def test_photo_cannot_be_reused(world):
    r1, body = punch(world, "jan", 1)
    r2, _ = punch(world, "sup", 1, photo=False, photo_media_id=body["photo_media_id"])
    assert r2.status_code == 409


def test_capture_window(world):
    yesterday = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    r, _ = punch(world, "jan", 1, ts=yesterday)
    assert r.status_code == 422 and r.json()["error"]["code"] == "outside_journey"
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    r, _ = punch(world, "jan", 1, ts=future)
    assert r.status_code == 422 and r.json()["error"]["code"] == "clock_skew"
    r, _ = punch(world, "jan", 1, ts="2026-01-01T10:00:00")
    assert r.status_code == 422  # naive timestamps rejected


def test_cancelled_journey_rejects(world):
    world.client.post(f"/api/v1/journeys/{world.journey['id']}/cancel", headers=world.h("manager"),
                      json={"version": world.journey["version"], "reason": "cancelled"})
    r, _ = punch(world, "jan", 1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "journey_cancelled"


def test_group_attendance_partial_success(world):
    world.client.post(f"/api/v1/staff-allocation/{world.journey['id']}", headers=world.h("manager"),
                      json={"user_ids": [str(world.jan2.id)]})
    punch(world, "jan", 1)
    members = [dict(id=str(uuid.uuid4()), employee_id=str(u.id), photo_media_id=upload(world.client, world.sup, world.a.id, "attendance_photo"))
               for u in (world.sup, world.jan, world.jan2)]
    body = dict(group_submission_id=str(uuid.uuid4()), journey_id=world.journey["id"], stage=1, device_timestamp=now_iso(),
                latitude=23.18, longitude=79.98, members=members)
    r = world.client.post(f"{API}/group", headers=world.h("sup"), json=body)
    assert r.status_code == 200
    outcomes = {m["employee_id"]: m["outcome"] for m in r.json()}
    assert outcomes == {str(world.sup.id): "created", str(world.jan.id): "rejected", str(world.jan2.id): "created"}
    again = world.client.post(f"{API}/group", headers=world.h("sup"), json=body).json()
    assert {m["employee_id"]: m["outcome"] for m in again}[str(world.jan2.id)] == "replayed"
    assert world.db.scalar(select(func.count()).select_from(Attendance)) == 3


def test_review(world):
    r, _ = punch(world, "jan", 1)
    att_id = r.json()["id"]
    assert world.client.post(f"{API}/{att_id}/review", headers=world.h("sup"), json={"status": "verified"}).status_code == 403
    r = world.client.post(f"{API}/{att_id}/review", headers=world.h("manager"), json={"status": "rejected", "remarks": "blurry"})
    assert r.status_code == 200 and r.json()["verification_status"] == "rejected"


def test_listing_scope(world):
    punch(world, "jan", 1)
    assert world.client.get(API, headers=world.h("jan")).json()["total"] == 1
    assert world.client.get(API, headers=world.h("manager")).json()["total"] == 1
    assert world.client.get(API, headers=world.h("manager_b")).json()["total"] == 0
