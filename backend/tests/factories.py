import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.errors import Unauthenticated
from app.models import Division, RoleId, User, UserStatus
from app.providers.external import PnrResult, ProviderUnavailable
from app.timeutil import today_ist

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + bytes(200)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(200)
PDF = b"%PDF-1.4\n" + bytes(200)


class FakeVerifier:
    """Accepts tokens of the form 'tok-<firebase uid>'; claims can be customised per uid."""

    def __init__(self) -> None:
        self.claims: dict[str, dict] = {}

    def verify(self, token: str) -> dict:
        if not token.startswith("tok-"):
            raise Unauthenticated("Invalid or expired token", code="invalid_token")
        uid = token[4:]
        return self.claims.get(uid, {"uid": uid})


class FakeSms:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.down = False

    def send_otp(self, mobile: str, code: str) -> None:
        if self.down:
            raise ProviderUnavailable("down")
        self.sent.append((mobile, code))

    @property
    def last_code(self) -> str:
        return self.sent[-1][1]


class FakePnr:
    def __init__(self) -> None:
        self.results: dict[str, PnrResult] = {}
        self.down = False

    def lookup(self, pnr: str) -> PnrResult:
        if self.down:
            raise ProviderUnavailable("down")
        return self.results.get(pnr, PnrResult(found=False))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def auth(user: User) -> dict:
    return {"Authorization": f"Bearer tok-{user.firebase_uid}"}


def make_division(db, code: str) -> Division:
    d = Division(code=code, name=f"{code} Division")
    db.add(d)
    db.commit()
    return d


_mobile_seq = iter(range(10_000_000))


def make_user(db, division: Division, role: RoleId, name: str, **kw) -> User:
    u = User(emp_id=f"{division.code}-{name}", name=name.title(), role_id=int(role), division_id=division.id,
             firebase_uid=kw.pop("firebase_uid", f"uid-{division.code}-{name}"), status=kw.pop("status", UserStatus.ACTIVE),
             mobile=kw.pop("mobile", f"9{next(_mobile_seq):09d}"), **kw)
    db.add(u)
    db.commit()
    return u


def upload(client, user: User, division_id, kind: str, data: bytes = PNG, content_type: str = "image/png") -> str:
    media_id = str(uuid.uuid4())
    r = client.post("/api/v1/media", headers=auth(user), json=dict(
        id=media_id, division_id=str(division_id), kind=kind, content_type=content_type, size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest()))
    assert r.status_code == 201, r.text
    r = client.put(f"/api/v1/media/{media_id}/content", headers=auth(user), content=data)
    assert r.status_code == 200, r.text
    return media_id


@dataclass
class World:
    db: object
    client: object
    a: Division
    b: Division
    users: dict[str, User] = field(default_factory=dict)
    train: dict | None = None
    journey: dict | None = None

    def __getattr__(self, name):
        users = self.__dict__.get("users", {})
        if name in users:
            return users[name]
        raise AttributeError(name)

    def h(self, name: str) -> dict:
        return auth(self.users[name])

    @classmethod
    def build(cls, db, client) -> "World":
        a, b = make_division(db, "AAA"), make_division(db, "BBB")
        w = cls(db=db, client=client, a=a, b=b)
        for div, specs in ((a, [("sa", RoleId.SUPER_ADMIN), ("admin", RoleId.ADMIN), ("manager", RoleId.MANAGER),
                                ("sup", RoleId.SUPERVISOR), ("sup2", RoleId.SUPERVISOR), ("jan", RoleId.JANITOR),
                                ("jan2", RoleId.JANITOR), ("contractor", RoleId.CONTRACTOR)]),
                           (b, [("manager_b", RoleId.MANAGER), ("sup_b", RoleId.SUPERVISOR), ("jan_b", RoleId.JANITOR)])):
            for name, role in specs:
                w.users[name] = make_user(db, div, role, name)
        w.train = w.create_train()
        w.journey = w.create_journey(staff=["jan"])
        w.create_banks()
        return w

    def create_train(self, **overrides) -> dict:
        body = dict(division_id=str(self.a.id), train_no=overrides.pop("train_no", "12001"), name="Shatabdi Test",
                    duration_days=1, operational_days=2, inspection_rounds_per_day=2, before_inspection_enabled=True,
                    after_inspection_enabled=True, daywise=False,
                    coaches=[{"code": "B1", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"}])
        body.update(overrides)
        r = self.client.post("/api/v1/trains", headers=self.h("manager"), json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def create_journey(self, staff=(), train=None, journey_date=None, **overrides) -> dict:
        train = train or self.train
        body = dict(division_id=str(self.a.id), train_id=train["id"], journey_date=str(journey_date or today_ist()),
                    supervisor_id=str(self.sup.id), staff_ids=[str(self.users[s].id) for s in staff])
        body.update(overrides)
        r = self.client.post("/api/v1/journeys", headers=self.h("manager"), json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def create_banks(self) -> None:
        for audience in ("passenger", "railway"):
            r = self.client.post("/api/v1/feedback/question-banks", headers=self.h("admin"), json=dict(
                division_id=str(self.a.id), audience=audience, name=f"{audience} v1", scale_min=1, scale_max=5,
                questions=[dict(text_en="Toilet cleaning", applies_ac=True, applies_non_ac=True),
                           dict(text_en="Bedroll quality", applies_ac=True, applies_non_ac=False),
                           dict(text_en="Staff behaviour", applies_ac=True, applies_non_ac=True, required=False)]))
            assert r.status_code == 201, r.text
            bank = r.json()
            assert self.client.post(f"/api/v1/feedback/question-banks/{bank['id']}/activate", headers=self.h("admin")).status_code == 200
            setattr(self, f"{audience}_bank", bank)
