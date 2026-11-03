import uuid
from datetime import timedelta

from sqlalchemy import select, update

from app.models import OtpChallenge, PassengerFeedback
from app.providers.external import PnrResult
from tests.factories import now_iso, upload

API = "/api/v1/feedback"


def start(world, pnr="1234567890", mobile="9123456789", coach="B1", by="sup", **extra):
    body = dict(id=str(uuid.uuid4()), journey_id=world.journey["id"], coach_code=coach, journey_day=1,
                passenger_name="Asha", mobile=mobile, pnr=pnr, seat_no="12", device_timestamp=now_iso(),
                latitude=23.1, longitude=79.9, **extra)
    return world.client.post(f"{API}/passenger", headers=world.h(by), json=body)


def valid_pnr(fakes, pnr="1234567890", train="12001", coaches=("B1",)):
    fakes[2].results[pnr] = PnrResult(found=True, train_number=train, train_name="Test", coach_ids=frozenset(coaches))


def ratings(world, coach_class="AC"):
    qs = world.passenger_bank["questions"]
    applicable = [q for q in qs if (q["applies_ac"] if coach_class == "AC" else q["applies_non_ac"])]
    return [{"question_id": q["id"], "value": 4} for q in applicable if q["required"]]


def verified_feedback(world, fakes, **kw):
    valid_pnr(fakes, kw.get("pnr", "1234567890"), coaches=(kw.get("coach", "B1"),))
    fb = start(world, **kw).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 200, r.text
    return r.json()


def test_full_passenger_flow_never_exposes_otp(world, fakes):
    valid_pnr(fakes)
    r = start(world)
    assert r.status_code == 201, r.text
    fb = r.json()
    assert (fb["status"], fb["pnr_status"], fb["otp_status"]) == ("draft", "pending", "not_sent")
    assert fb["mobile_masked"] == "91XXXXXX89" and "mobile" not in fb

    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "pnr_pending"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    assert r.json()["pnr_status"] == "valid" and r.json()["status"] == "draft"

    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 200
    code = fakes[1].last_code
    assert code not in r.text and len(code) == 6
    stored = world.db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == uuid.UUID(fb["id"])))
    assert code not in stored.code_hash and len(stored.code_hash) == 64

    r = world.client.post(f"{API}/passenger/{fb['id']}/complete", headers=world.h("sup"), json={"ratings": ratings(world)})
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_verified"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": code})
    assert r.json()["status"] == "verified"

    voice = upload(world.client, world.sup, world.a.id, "feedback_voice", data=b"ID3" + bytes(300), content_type="audio/mpeg")
    r = world.client.post(f"{API}/passenger/{fb['id']}/complete", headers=world.h("sup"),
                          json={"ratings": ratings(world), "comments": "clean", "voice_media_id": voice})
    assert r.status_code == 200 and r.json()["status"] == "completed" and len(r.json()["ratings"]) == 2


def test_wrong_otp_attempts_lock(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    wrong = "000000" if fakes[1].last_code != "000000" else "111111"
    for i in range(4):
        r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": wrong})
        assert r.json()["error"]["code"] == "otp_invalid"
        assert r.json()["error"]["details"]["attempts_remaining"] == 4 - i
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": wrong})
    assert r.json()["error"]["code"] == "otp_locked"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 422
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("sup")).json()["status"] == "void"


def test_expired_otp_and_resend_limit(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    world.db.execute(update(OtpChallenge).values(expires_at=OtpChallenge.expires_at - timedelta(hours=1)))
    world.db.commit()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.json()["error"]["code"] == "otp_expired"
    assert world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup")).json()["sends_remaining"] == 1
    assert world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup")).status_code == 200
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.json()["error"]["code"] == "otp_send_limit"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.json()["status"] == "verified"


def test_pnr_mismatch_voids_and_provider_outage_keeps_pending(world, fakes):
    valid_pnr(fakes, train="99999")
    fb = start(world).json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup")).json()
    assert (r["status"], r["pnr_status"], r["void_reason"]) == ("void", "invalid", "PNR is for a different train")

    valid_pnr(fakes, pnr="5555555555", coaches=("A1",))
    fb = start(world, pnr="5555555555", mobile="9000000001").json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup")).json()
    assert r["void_reason"] == "PNR coach does not match"

    fakes[2].down = True
    fb = start(world, pnr="6666666666", mobile="9000000002").json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "pnr_unavailable"
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("sup")).json()["pnr_status"] == "pending"


def test_sms_outage_does_not_create_challenge(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    fakes[1].down = True
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 503
    assert world.db.scalar(select(OtpChallenge)) is None


def test_duplicate_pnr_and_mobile(world, fakes):
    verified_feedback(world, fakes)
    r = start(world, mobile="9000000003")
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pnr"
    r = start(world, pnr="2222222222")
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_mobile"


def test_duplicate_race_caught_by_database(world, fakes):
    valid_pnr(fakes)
    a, b = start(world).json(), start(world, mobile="9000000004").json()  # both drafts for the same PNR
    for fb in (a, b):
        world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{a['id']}/send-otp", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{a['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    world.client.post(f"{API}/passenger/{b['id']}/send-otp", headers=world.h("sup"))
    r = world.client.post(f"{API}/passenger/{b['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_feedback"


def test_staff_mobile_rejected_and_pnr_required(world, fakes):
    r = start(world, mobile=world.jan.mobile)
    assert r.status_code == 422 and r.json()["error"]["code"] == "staff_mobile"
    r = start(world, pnr=None)
    assert r.status_code == 422 and r.json()["error"]["code"] == "pnr_required"


def test_only_collector_continues(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("manager"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_collector"
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("manager_b")).status_code == 404


def test_rating_validation(world, fakes):
    fb = verified_feedback(world, fakes, coach="S1", pnr="1234567890")  # Non-AC: bedroll question does not apply
    bedroll = next(q for q in world.passenger_bank["questions"] if q["text_en"] == "Bedroll quality")
    url = f"{API}/passenger/{fb['id']}/complete"
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": ratings(world, "NON_AC") + [{"question_id": bedroll["id"], "value": 3}]})
    assert r.json()["error"]["code"] == "invalid_question"
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": [{**ratings(world, "NON_AC")[0], "value": 9}]})
    assert r.json()["error"]["code"] == "rating_range"
    optional_only = [{"question_id": world.passenger_bank["questions"][2]["id"], "value": 3}]
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": optional_only})
    assert r.json()["error"]["code"] == "missing_rating"
    assert world.client.post(url, headers=world.h("sup"), json={"ratings": ratings(world, "NON_AC")}).status_code == 200


def test_policy_without_pnr_or_otp(world, fakes):
    world.client.put(f"/api/v1/divisions/{world.a.id}/policy", headers=world.h("admin"),
                     json={"passenger_pnr_required": False, "passenger_otp_required": False})
    fb = start(world, pnr=None).json()
    assert (fb["status"], fb["pnr_status"], fb["otp_status"]) == ("verified", "not_required", "not_required")


def test_railway_feedback_limit(world):
    def railway(rid):
        qs = world.railway_bank["questions"]
        return world.client.post(f"{API}/railway", headers=world.h("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=world.journey["id"], railway_employee_id=rid, official_name="Insp. Rao",
            journey_day=1, device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
            ratings=[{"question_id": q["id"], "value": 5} for q in qs if q["required"]]))
    assert railway("R1").status_code == 201
    assert railway("R2").status_code == 201
    r = railway("R3")
    assert r.status_code == 409 and r.json()["error"]["code"] == "railway_feedback_limit"


def test_questions_endpoint_filters_by_coach_class(world):
    r = world.client.get(f"{API}/questions?journey_id={world.journey['id']}&coach_code=S1", headers=world.h("sup"))
    assert [q["text_en"] for q in r.json()] == ["Toilet cleaning", "Staff behaviour"]


def test_void_by_reviewer(world, fakes):
    fb = verified_feedback(world, fakes)
    assert world.client.post(f"{API}/passenger/{fb['id']}/void", headers=world.h("sup"), json={"reason": "duplicate"}).status_code == 403
    r = world.client.post(f"{API}/passenger/{fb['id']}/void", headers=world.h("manager"), json={"reason": "fraudulent entry"})
    assert r.json()["status"] == "void"
    assert world.db.get(PassengerFeedback, uuid.UUID(fb["id"])).void_reason == "fraudulent entry"
