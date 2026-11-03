import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError, BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import Attendance, AttendanceStage, Journey, MediaKind, StaffAllocation, VerificationStatus
from app.schemas.common import PageParams
from app.schemas.operations import AttendanceIn, GroupAttendanceIn, ReviewIn
from app.security.principal import Principal
from app.services import media
from app.services.common import audit, check_replay, get_or_404, paginate, payload_hash
from app.services.journeys import check_capture_window, get_journey, is_allocated
from app.services.policy import get_policy
from app.timeutil import utcnow


def _may_submit_for(p: Principal, j: Journey, employee_id: uuid.UUID) -> bool:
    return employee_id == p.id or j.supervisor_id == p.id or p.has("attendance.review", j.division_id)


def create(db: Session, p: Principal, body: AttendanceIn, *, sync_op_id: uuid.UUID | None = None,
           commit: bool = True) -> tuple[Attendance, bool]:
    """Returns (record, replayed)."""
    digest = payload_hash(body)
    if (existing := check_replay(db, Attendance, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True

    j = get_journey(db, p, body.journey_id, for_update=False)
    p.require("attendance.submit", j.division_id)
    policy = get_policy(db, j.division_id)
    check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    if not is_allocated(db, j.id, body.employee_id):
        raise BusinessRuleViolation("Employee is not allocated to this journey", code="not_allocated")
    if not _may_submit_for(p, j, body.employee_id):
        raise Forbidden("Only the employee, the journey supervisor or a reviewer may record this attendance",
                        code="not_authorized_for_employee")

    previous = {s for s in db.scalars(select(Attendance.stage).where(
        Attendance.journey_id == j.id, Attendance.employee_id == body.employee_id))}
    if body.stage in previous:
        raise Conflict("Attendance already recorded for this stage", code="duplicate_attendance")
    if body.stage > AttendanceStage.SOURCE and body.stage - 1 not in previous:
        raise BusinessRuleViolation(f"Stage {body.stage - 1} must be recorded first", code="stage_order",
                                    details={"recorded_stages": sorted(previous)})

    photo_id = media.claim(db, body.photo_media_id, MediaKind.ATTENDANCE_PHOTO, j.division_id, p.id,
                           required=policy.attendance_photo_required, label="Attendance photo")
    record = Attendance(**body.model_dump(exclude={"photo_media_id"}), photo_media_id=photo_id, division_id=j.division_id,
                        created_by_id=p.id, payload_hash=digest, sync_op_id=sync_op_id)
    db.add(record)
    try:
        db.flush()
    except IntegrityError as exc:
        raise Conflict("Attendance already recorded for this stage or photo already used",
                       code="duplicate_attendance") from exc
    audit(db, actor_id=p.id, action="attendance.create", entity=record, division_id=j.division_id,
          changes={"employee_id": body.employee_id, "stage": body.stage, "group": body.group_submission_id})
    if commit:
        db.commit()
    return record, False


def create_group(db: Session, p: Principal, body: GroupAttendanceIn) -> list[dict]:
    """Supervisor records one stage for several staff. Each member succeeds or fails independently."""
    results = []
    for m in body.members:
        item = AttendanceIn(id=m.id, journey_id=body.journey_id, employee_id=m.employee_id, stage=body.stage,
                            photo_media_id=m.photo_media_id, group_submission_id=body.group_submission_id,
                            device_timestamp=body.device_timestamp, latitude=body.latitude, longitude=body.longitude,
                            gps_accuracy_m=body.gps_accuracy_m)
        savepoint = db.begin_nested()
        try:
            record, replayed = create(db, p, item, commit=False)
            savepoint.commit()
            results.append(dict(id=m.id, employee_id=m.employee_id, outcome="replayed" if replayed else "created", record=record))
        except AppError as exc:
            savepoint.rollback()
            results.append(dict(id=m.id, employee_id=m.employee_id, outcome="rejected",
                                error={"code": exc.code, "message": exc.message}))
    db.commit()
    return results


def review(db: Session, p: Principal, attendance_id: uuid.UUID, body: ReviewIn) -> Attendance:
    record = get_or_404(db, Attendance, attendance_id, "Attendance")
    p.require("attendance.review", record.division_id)
    if record.created_by_id == p.id:
        raise Forbidden("You cannot review attendance you recorded", code="self_review")
    audit(db, actor_id=p.id, action="attendance.review", entity=record, division_id=record.division_id,
          changes={"status": {"from": record.verification_status, "to": body.status}, "remarks": body.remarks})
    record.verification_status = VerificationStatus(body.status)
    record.verified_by_id = p.id
    record.verified_at = utcnow()
    record.review_remarks = body.remarks
    db.commit()
    return record


def get(db: Session, p: Principal, attendance_id: uuid.UUID) -> Attendance:
    record = db.get(Attendance, attendance_id)
    if record is None or not _readable(db, p, record):
        raise NotFound("Attendance not found")
    return record


def _readable(db: Session, p: Principal, record: Attendance) -> bool:
    if not p.has("attendance.read", record.division_id):
        return False
    if p.has("journeys.read_all", record.division_id) or record.employee_id == p.id or record.created_by_id == p.id:
        return True
    return db.get(Journey, record.journey_id).supervisor_id == p.id


def list_records(db: Session, p: Principal, params: PageParams, *, journey_id, employee_id, stage, date_from, date_to,
                 verification_status):
    divisions = p.require_any_division("attendance.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = select(Attendance).join(Journey, Journey.id == Attendance.journey_id).where(
        Attendance.division_id.in_(divisions),
        or_(Attendance.division_id.in_(full), Attendance.employee_id == p.id, Attendance.created_by_id == p.id,
            Journey.supervisor_id == p.id),
    )
    for col, val in ((Attendance.journey_id, journey_id), (Attendance.employee_id, employee_id), (Attendance.stage, stage),
                     (Attendance.verification_status, verification_status)):
        if val is not None:
            stmt = stmt.where(col == val)
    if date_from:
        stmt = stmt.where(Attendance.device_timestamp >= date_from)
    if date_to:
        stmt = stmt.where(Attendance.device_timestamp < date_to)
    return paginate(db, stmt.order_by(Attendance.device_timestamp.desc(), Attendance.id), params)


def journey_status(db: Session, p: Principal, journey_id: uuid.UUID) -> list[dict]:
    j = get_journey(db, p, journey_id)
    p.require("attendance.read", j.division_id)
    allocations = db.scalars(select(StaffAllocation).where(
        StaffAllocation.journey_id == j.id, StaffAllocation.removed_at.is_(None)).order_by(StaffAllocation.role_id)).unique().all()
    taken: dict[uuid.UUID, dict[int, uuid.UUID]] = {}
    for att_id, emp, stage in db.execute(select(Attendance.id, Attendance.employee_id, Attendance.stage).where(Attendance.journey_id == j.id)):
        taken.setdefault(emp, {})[stage] = att_id
    out = []
    for a in allocations:
        done = taken.get(a.user_id, {})
        nxt = next((s for s in AttendanceStage if s not in done), None)
        cells = [dict(stage=int(s), status="taken" if s in done else ("next" if s == nxt else "locked"),
                      attendance_id=done.get(s)) for s in AttendanceStage]
        out.append(dict(employee_id=a.user_id, name=a.user.name, emp_id=a.user.emp_id, role_id=a.role_id,
                        stages=cells, completed=nxt is None))
    return out
