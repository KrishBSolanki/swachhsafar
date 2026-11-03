import uuid

from tests.factories import now_iso, upload

API = "/api/v1/inspections"


def inspect(world, coach="B1", day=1, rnd=1, phase="B", by="sup", journey=None, photo=True, **extra):
    user = world.users[by]
    body = dict(id=str(uuid.uuid4()), journey_id=(journey or world.journey)["id"], coach_code=coach, day=day, round=rnd,
                phase=phase, device_timestamp=now_iso(), latitude=23.1, longitude=79.9, comments="ok", **extra)
    if photo:
        body["photo_media_id"] = upload(world.client, user, world.a.id, "inspection_photo")
    return world.client.post(API, headers=world.h(by), json=body)


def test_round_and_phase_ordering(world):
    r = inspect(world, phase="A")
    assert r.status_code == 422 and r.json()["error"]["code"] == "phase_order"
    assert inspect(world, phase="B").status_code == 201
    r = inspect(world, rnd=2, phase="B")
    assert r.status_code == 201, r.text  # round 2 Before only needs round 1 Before
    assert inspect(world, phase="A").status_code == 201
    assert inspect(world, rnd=2, phase="A").status_code == 201
    r = inspect(world, rnd=3, phase="B")
    assert r.status_code == 422 and r.json()["error"]["code"] == "round_out_of_range"


def test_duplicate_and_unknown_coach(world):
    assert inspect(world).status_code == 201
    r = inspect(world)
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_inspection"
    r = inspect(world, coach="Z9")
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_coach"


def test_future_day_not_open(world):
    r = inspect(world, day=2)
    assert r.status_code == 422 and r.json()["error"]["code"] == "day_not_open"
    r = inspect(world, day=3)
    assert r.status_code == 422 and r.json()["error"]["code"] == "day_out_of_range"


def test_phase_disabled_by_train_config(world):
    after_only = world.create_train(train_no="13001", before_inspection_enabled=False, inspection_rounds_per_day=1)
    j = world.create_journey(train=after_only)
    r = inspect(world, journey=j, phase="B")
    assert r.status_code == 422 and r.json()["error"]["code"] == "phase_disabled"
    assert inspect(world, journey=j, phase="A").status_code == 201


def test_video_attachment_and_photo_policy(world):
    video = upload(world.client, world.sup, world.a.id, "inspection_video",
                   data=b"\x00\x00\x00\x18ftypmp42" + bytes(300), content_type="video/mp4")
    r = inspect(world, video_media_id=video)
    assert r.status_code == 201 and r.json()["video_media_id"] == video
    r = inspect(world, coach="S1", photo=False)
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_required"


def test_janitor_not_on_journey_cannot_inspect(world):
    r = inspect(world, by="jan2", photo=False)
    assert r.status_code == 404  # journey invisible to unallocated janitor
    r = inspect(world, by="jan", photo=False)
    assert r.status_code == 403  # janitors lack inspections.submit


def test_grid_and_completion(world):
    inspect(world)
    inspect(world, phase="A")
    grid = world.client.get(f"{API}/journeys/{world.journey['id']}/status", headers=world.h("sup")).json()
    b1d1 = next(g for g in grid if g["coach_code"] == "B1" and g["day"] == 1)
    assert (b1d1["required"], b1d1["done"], b1d1["day_open"]) == (4, 2, True)
    statuses = {(c["round"], c["phase"]): c["status"] for c in b1d1["cells"]}
    assert statuses == {(1, "B"): "taken", (1, "A"): "taken", (2, "B"): "open", (2, "A"): "locked"}
    d2 = next(g for g in grid if g["coach_code"] == "B1" and g["day"] == 2)
    assert d2["day_open"] is False and {c["status"] for c in d2["cells"]} == {"locked"}
    summary = world.client.get(f"/api/v1/journeys/{world.journey['id']}/summary", headers=world.h("manager")).json()
    assert summary["inspections_required"] == 2 * 2 * 2 * 2 and summary["inspections_done"] == 2
    assert summary["inspection_completion_pct"] == 12.5


def test_daywise_only_current_day(world):
    daywise = world.create_train(train_no="14001", daywise=True, inspection_rounds_per_day=1, before_inspection_enabled=False)
    j = world.create_journey(train=daywise)
    assert inspect(world, journey=j, phase="A").status_code == 201
    grid = world.client.get(f"{API}/journeys/{j['id']}/status", headers=world.h("sup")).json()
    assert [g["day_open"] for g in grid if g["coach_code"] == "B1"] == [True, False]
