import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import Inspection, InspectionPhase, Journey, MediaKind, VerificationStatus
from app.schemas.common import PageParams
from app.schemas.operations import InspectionIn, ReviewIn
from app.security.principal import Principal
from app.services import media
from app.services.common import audit, check_replay, get_or_404, paginate, payload_hash
from app.services.journeys import check_capture_window, get_journey, is_allocated, journey_day_for
from app.services.policy import get_policy
from app.timeutil import today_ist, utcnow


def enabled_phases(j: Journey) -> list[InspectionPhase]:
    return [ph for ph, on in ((InspectionPhase.BEFORE, j.before_inspection_enabled),
                              (InspectionPhase.AFTER, j.after_inspection_enabled)) if on]


def day_is_open(j: Journey, day: int, today) -> bool:
    current = journey_day_for(j, today)
    return current == day if j.daywise else 1 <= day <= current


def create(db: Session, p: Principal, body: InspectionIn, *, sync_op_id: uuid.UUID | None = None,
           commit: bool = True) -> tuple[Inspection, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, Inspection, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True

    j = get_journey(db, p, body.journey_id)
    p.require("inspections.submit", j.division_id)
    if not (j.supervisor_id == p.id or is_allocated(db, j.id, p.id) or p.has("inspections.review", j.division_id)):
        raise Forbidden("Only journey staff or reviewers may inspect this journey", code="not_journey_staff")
    policy = get_policy(db, j.division_id)
    captured_on = check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)

    if body.coach_code not in {c.code for c in j.coaches}:
        raise BusinessRuleViolation("Coach is not part of this journey", code="unknown_coach")
    if body.day > j.operational_days:
        raise BusinessRuleViolation(f"Day must be between 1 and {j.operational_days}", code="day_out_of_range")
    if not day_is_open(j, body.day, captured_on):
        raise BusinessRuleViolation("Inspection for this day is not open at the capture time", code="day_not_open")
    if body.round > j.inspection_rounds_per_day:
        raise BusinessRuleViolation(f"Round must be between 1 and {j.inspection_rounds_per_day}", code="round_out_of_range")
    if body.phase not in enabled_phases(j):
        raise BusinessRuleViolation(f"Phase {body.phase.value} inspections are disabled for this journey", code="phase_disabled")

    done = set(db.execute(select(Inspection.round, Inspection.phase).where(
        Inspection.journey_id == j.id, Inspection.coach_code == body.coach_code, Inspection.day == body.day)).tuples())
    if (body.round, body.phase) in done:
        raise Conflict("Inspection already recorded for this coach, day, round and phase", code="duplicate_inspection")
    if body.round > 1 and (body.round - 1, body.phase) not in done:
        raise BusinessRuleViolation(f"Round {body.round - 1} ({body.phase.value}) must be recorded first", code="round_order")
    if body.phase == InspectionPhase.AFTER and j.before_inspection_enabled and (body.round, InspectionPhase.BEFORE) not in done:
        raise BusinessRuleViolation("The Before inspection of this round must be recorded first", code="phase_order")

    photo_id = media.claim(db, body.photo_media_id, MediaKind.INSPECTION_PHOTO, j.division_id, p.id,
                           required=policy.inspection_photo_required, label="Inspection photo")
    video_id = media.claim(db, body.video_media_id, MediaKind.INSPECTION_VIDEO, j.division_id, p.id,
                           required=False, label="Inspection video")
    record = Inspection(**body.model_dump(exclude={"photo_media_id", "video_media_id"}), photo_media_id=photo_id,
                        video_media_id=video_id, division_id=j.division_id, created_by_id=p.id, payload_hash=digest,
                        sync_op_id=sync_op_id)
    db.add(record)
    try:
        db.flush()
    except IntegrityError as exc:
        raise Conflict("Inspection already recorded or media already used", code="duplicate_inspection") from exc
    audit(db, actor_id=p.id, action="inspection.create", entity=record, division_id=j.division_id,
          changes={"coach": body.coach_code, "day": body.day, "round": body.round, "phase": body.phase})
    if commit:
        db.commit()
    return record, False


def review(db: Session, p: Principal, inspection_id: uuid.UUID, body: ReviewIn) -> Inspection:
    record = get_or_404(db, Inspection, inspection_id, "Inspection")
    p.require("inspections.review", record.division_id)
    if record.created_by_id == p.id:
        raise Forbidden("You cannot review your own inspection", code="self_review")
    audit(db, actor_id=p.id, action="inspection.review", entity=record, division_id=record.division_id,
          changes={"status": {"from": record.verification_status, "to": body.status}, "remarks": body.remarks})
    record.verification_status = VerificationStatus(body.status)
    record.verified_by_id = p.id
    record.verified_at = utcnow()
    record.review_remarks = body.remarks
    db.commit()
    return record


def get(db: Session, p: Principal, inspection_id: uuid.UUID) -> Inspection:
    record = db.get(Inspection, inspection_id)
    if record is None or not p.has("inspections.read", record.division_id):
        raise NotFound("Inspection not found")
    get_journey(db, p, record.journey_id)  # enforces journey visibility
    return record


def list_records(db: Session, p: Principal, params: PageParams, *, journey_id, coach_code, day, phase, verification_status):
    divisions = p.require_any_division("inspections.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = select(Inspection).join(Journey, Journey.id == Inspection.journey_id).where(
        Inspection.division_id.in_(divisions),
        or_(Inspection.division_id.in_(full), Inspection.created_by_id == p.id, Journey.supervisor_id == p.id),
    )
    for col, val in ((Inspection.journey_id, journey_id), (Inspection.coach_code, coach_code), (Inspection.day, day),
                     (Inspection.phase, phase), (Inspection.verification_status, verification_status)):
        if val is not None:
            stmt = stmt.where(col == val)
    return paginate(db, stmt.order_by(Inspection.day, Inspection.coach_code, Inspection.round, Inspection.phase), params)


def journey_grid(db: Session, p: Principal, journey_id: uuid.UUID) -> list[dict]:
    j = get_journey(db, p, journey_id)
    p.require("inspections.read", j.division_id)
    taken = {(c, d, r, ph): i for i, c, d, r, ph in db.execute(select(
        Inspection.id, Inspection.coach_code, Inspection.day, Inspection.round, Inspection.phase).where(Inspection.journey_id == j.id))}
    phases = enabled_phases(j)
    today = today_ist()
    out = []
    for coach in j.coaches:
        for day in range(1, j.operational_days + 1):
            open_ = j.status == "planned" and j.journey_date <= today <= j.end_date and day_is_open(j, day, today)
            cells = []
            for rnd in range(1, j.inspection_rounds_per_day + 1):
                for ph in phases:
                    key = (coach.code, day, rnd, ph)
                    if key in taken:
                        cells.append(dict(round=rnd, phase=ph, status="taken", inspection_id=taken[key]))
                        continue
                    # Same ordering rules as create(): previous round of this phase, and Before ahead of After.
                    ready = (rnd == 1 or (coach.code, day, rnd - 1, ph) in taken) and (
                        ph == InspectionPhase.BEFORE or not j.before_inspection_enabled
                        or (coach.code, day, rnd, InspectionPhase.BEFORE) in taken)
                    cells.append(dict(round=rnd, phase=ph, status="open" if open_ and ready else "locked"))
            done = sum(1 for c in cells if c["status"] == "taken")
            out.append(dict(coach_code=coach.code, day=day, day_open=open_, required=len(cells), done=done, cells=cells))
    return out
