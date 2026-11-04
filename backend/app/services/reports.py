"""Read-only aggregation. Every figure is computed in PostgreSQL; nothing loads full datasets into Python."""

import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy import Integer, and_, case, cast, distinct, func, literal, select
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation, Conflict, Forbidden
from app.models import (
    Attendance,
    Complaint,
    ComplaintCategory,
    ComplaintStatus,
    Inspection,
    InventoryItem,
    InventoryTransaction,
    InventoryTxnType,
    Journey,
    JourneyCoach,
    JourneyState,
    JourneyStatus,
    PassengerFeedback,
    PassengerFeedbackRating,
    PassengerFeedbackStatus,
    Question,
    QuestionBank,
    RailwayFeedback,
    RailwayFeedbackRating,
    StaffAllocation,
    Train,
    User,
    VerificationStatus,
)
from app.security.principal import Principal
from app.sqlcompat import date_text, hours_between
from app.services.journeys import get_journey, journey_state, state_clause
from app.timeutil import IST, today_ist, utcnow

COUNTED = (PassengerFeedbackStatus.VERIFIED, PassengerFeedbackStatus.COMPLETED)


def _divisions(p: Principal, division_id: uuid.UUID | None, permission: str = "reports.read") -> list[uuid.UUID]:
    divisions = p.require_any_division(permission)
    if division_id is not None:
        if division_id not in divisions:
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        return [division_id]
    return divisions


def _range(date_from: date, date_to: date) -> tuple[datetime, datetime]:
    if date_to < date_from or (date_to - date_from).days > 366:
        raise BusinessRuleViolation("Date range must be ascending and at most one year")
    return (datetime.combine(date_from, time.min, IST), datetime.combine(date_to + timedelta(days=1), time.min, IST))


def _journeys_in(divisions, date_from: date, date_to: date):
    return and_(Journey.division_id.in_(divisions), Journey.journey_date <= date_to, Journey.end_date >= date_from)


# ---- journey summary ---------------------------------------------------------------------------------------


def journey_summary(db: Session, p: Principal, journey_id: uuid.UUID) -> dict:
    j = get_journey(db, p, journey_id)
    if not (p.has("reports.read", j.division_id) or j.supervisor_id == p.id):
        raise Forbidden("Missing permission reports.read", code="permission_denied")
    jid = j.id
    staff = db.scalar(select(func.count()).where(StaffAllocation.journey_id == jid, StaffAllocation.removed_at.is_(None)))
    by_stage = dict(db.execute(select(Attendance.stage, func.count()).where(Attendance.journey_id == jid).group_by(Attendance.stage)).all())
    full = db.scalar(select(func.count()).select_from(
        select(Attendance.employee_id).where(Attendance.journey_id == jid).group_by(Attendance.employee_id)
        .having(func.count(distinct(Attendance.stage)) == 5).subquery()))
    coaches = db.scalar(select(func.count()).where(JourneyCoach.journey_id == jid))
    phases = int(j.before_inspection_enabled) + int(j.after_inspection_enabled)
    required = coaches * j.operational_days * j.inspection_rounds_per_day * phases
    done = db.scalar(select(func.count()).where(Inspection.journey_id == jid))
    fb = dict(db.execute(select(PassengerFeedback.status, func.count()).where(PassengerFeedback.journey_id == jid)
                         .group_by(PassengerFeedback.status)).all())
    railway = db.scalar(select(func.count()).where(RailwayFeedback.journey_id == jid, RailwayFeedback.verification_status != "rejected"))
    now = utcnow()
    c_open, c_overdue, c_closed = db.execute(select(
        func.count().filter(Complaint.status != ComplaintStatus.COMPLETED),
        func.count().filter(Complaint.status != ComplaintStatus.COMPLETED, Complaint.due_at < now),
        func.count().filter(Complaint.status == ComplaintStatus.COMPLETED),
    ).where(Complaint.journey_id == jid)).one()
    inv = db.scalar(select(func.count()).where(InventoryTransaction.journey_id == jid))
    return dict(
        journey_id=jid, state=journey_state(j).value, staff_allocated=staff, attendance_records=sum(by_stage.values()),
        attendance_by_stage={s: by_stage.get(s, 0) for s in range(1, 6)}, staff_fully_attended=full,
        inspections_required=required, inspections_done=done,
        inspection_completion_pct=round(100 * done / required, 2) if required else None,
        passenger_feedback_counted=sum(fb.get(s, 0) for s in COUNTED),
        passenger_feedback_completed=fb.get(PassengerFeedbackStatus.COMPLETED, 0),
        passenger_feedback_pending=fb.get(PassengerFeedbackStatus.DRAFT, 0),
        passenger_feedback_void=fb.get(PassengerFeedbackStatus.VOID, 0),
        railway_feedback=railway, complaints_open=c_open, complaints_overdue=c_overdue, complaints_closed=c_closed,
        inventory_lines=inv,
    )


# ---- attendance --------------------------------------------------------------------------------------------


def attendance_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date, group_by: str) -> list[dict]:
    divisions = _divisions(p, division_id)
    start, end = _range(date_from, date_to)
    if group_by == "employee":
        stmt = select(Attendance.employee_id, func.concat(User.name, " (", User.emp_id, ")")) \
            .join(User, User.id == Attendance.employee_id)
        group = [Attendance.employee_id, User.name, User.emp_id]
    elif group_by == "journey":
        stmt = select(Attendance.journey_id, func.concat(Train.train_no, " / ", date_text(db, Journey.journey_date))) \
            .join(Journey, Journey.id == Attendance.journey_id).join(Train, Train.id == Journey.train_id)
        group = [Attendance.journey_id, Journey.journey_date, Train.train_no]
    else:
        raise BusinessRuleViolation("group_by must be employee or journey")
    stage_cols = [func.count().filter(Attendance.stage == s) for s in range(1, 6)]
    stmt = stmt.add_columns(
        func.count(distinct(Attendance.journey_id)), func.count(), *stage_cols,
        func.count().filter(Attendance.verification_status == VerificationStatus.VERIFIED),
        func.count().filter(Attendance.verification_status == VerificationStatus.REJECTED),
    ).where(Attendance.division_id.in_(divisions), Attendance.device_timestamp >= start, Attendance.device_timestamp < end) \
        .group_by(*group).order_by(*group[1:])
    return [dict(key_id=r[0], label=r[1], journeys=r[2], records=r[3], stages={s: r[3 + s] for s in range(1, 6)},
                 verified=r[9], rejected=r[10]) for r in db.execute(stmt)]


# ---- inspections -------------------------------------------------------------------------------------------


def inspection_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date, coach_wise: bool) -> list[dict]:
    divisions = _divisions(p, division_id)
    per_coach = Journey.operational_days * Journey.inspection_rounds_per_day * (
        cast(Journey.before_inspection_enabled, Integer) + cast(Journey.after_inspection_enabled, Integer))
    done = (select(Inspection.journey_id, Inspection.coach_code, func.count().label("done"),
                   func.count().filter(Inspection.verification_status == VerificationStatus.VERIFIED).label("verified"),
                   func.count().filter(Inspection.verification_status == VerificationStatus.REJECTED).label("rejected"))
            .group_by(Inspection.journey_id, Inspection.coach_code).subquery())
    base = (select(Journey.id, Train.train_no, Journey.journey_date, JourneyCoach.code, per_coach.label("required"),
                   func.coalesce(done.c.done, 0).label("done"), func.coalesce(done.c.verified, 0).label("verified"),
                   func.coalesce(done.c.rejected, 0).label("rejected"))
            .join(Train, Train.id == Journey.train_id)
            .join(JourneyCoach, JourneyCoach.journey_id == Journey.id)
            .outerjoin(done, and_(done.c.journey_id == Journey.id, done.c.coach_code == JourneyCoach.code))
            .where(_journeys_in(divisions, date_from, date_to), Journey.status != JourneyStatus.CANCELLED))
    if coach_wise:
        rows = db.execute(base.order_by(Journey.journey_date, Train.train_no, JourneyCoach.position)).all()
        return [dict(journey_id=r[0], train_no=r[1], journey_date=r[2], coach_code=r[3], required=r[4], done=r[5],
                     completion_pct=round(100 * r[5] / r[4], 2) if r[4] else None, verified=r[6], rejected=r[7]) for r in rows]
    sub = base.subquery()
    rows = db.execute(select(sub.c.id, sub.c.train_no, sub.c.journey_date, func.sum(sub.c.required), func.sum(sub.c.done),
                             func.sum(sub.c.verified), func.sum(sub.c.rejected))
                      .group_by(sub.c.id, sub.c.train_no, sub.c.journey_date).order_by(sub.c.journey_date, sub.c.train_no)).all()
    return [dict(journey_id=r[0], train_no=r[1], journey_date=r[2], coach_code=None, required=int(r[3]), done=int(r[4]),
                 completion_pct=round(100 * int(r[4]) / int(r[3]), 2) if r[3] else None, verified=int(r[5]), rejected=int(r[6]))
            for r in rows]


# ---- feedback ----------------------------------------------------------------------------------------------


def _bank_for(db: Session, divisions, audience: str, bank_id: uuid.UUID | None) -> QuestionBank | None:
    if bank_id is not None:
        bank = db.get(QuestionBank, bank_id)
        if bank is None or bank.audience != audience or (bank.division_id is not None and bank.division_id not in divisions):
            raise BusinessRuleViolation("Question bank not available")
        return bank
    model = PassengerFeedback if audience == "passenger" else RailwayFeedback
    used = db.scalars(select(model.bank_id).where(model.division_id.in_(divisions)).distinct()).all()
    if len(used) > 1:
        raise BusinessRuleViolation("Several question banks are in use; pass bank_id", code="bank_required",
                                    details=[str(b) for b in used])
    return db.get(QuestionBank, used[0]) if used else None


def feedback_report(db: Session, p: Principal, *, audience: str, division_id, date_from: date, date_to: date,
                    journey_id: uuid.UUID | None, bank_id: uuid.UUID | None) -> dict:
    divisions = _divisions(p, division_id)
    start, end = _range(date_from, date_to)
    bank = _bank_for(db, divisions, audience, bank_id)
    if audience == "passenger":
        model, rating = PassengerFeedback, PassengerFeedbackRating
        by_status = dict(db.execute(select(model.status, func.count()).where(
            model.division_id.in_(divisions), model.server_timestamp >= start, model.server_timestamp < end,
            *( [model.journey_id == journey_id] if journey_id else [])).group_by(model.status)).all())
        counted = (model.status == PassengerFeedbackStatus.COMPLETED,)
        by_class = dict(db.execute(select(model.coach_class, func.count()).where(
            model.division_id.in_(divisions), model.server_timestamp >= start, model.server_timestamp < end, *counted,
            *([model.journey_id == journey_id] if journey_id else [])).group_by(model.coach_class)).all())
    else:
        model, rating = RailwayFeedback, RailwayFeedbackRating
        by_status = dict(db.execute(select(model.verification_status, func.count()).where(
            model.division_id.in_(divisions), model.server_timestamp >= start, model.server_timestamp < end,
            *([model.journey_id == journey_id] if journey_id else [])).group_by(model.verification_status)).all())
        counted = (model.verification_status != "rejected",)
        by_class = {}
    questions = []
    if bank is not None:
        stats = dict((qid, (n, avg)) for qid, n, avg in db.execute(
            select(rating.question_id, func.count(), func.avg(rating.value))
            .join(model, model.id == rating.feedback_id)
            .where(model.bank_id == bank.id, model.division_id.in_(divisions), model.server_timestamp >= start,
                   model.server_timestamp < end, *counted, *([model.journey_id == journey_id] if journey_id else []))
            .group_by(rating.question_id)))
        for q in bank.questions:
            n, avg = stats.get(q.id, (0, None))
            questions.append(dict(question_id=q.id, position=q.position, text_en=q.text_en, responses=n,
                                  average=round(float(avg), 3) if avg is not None else None))
    return dict(audience=audience, bank_id=bank.id if bank else None, scale_min=bank.scale_min if bank else None,
                scale_max=bank.scale_max if bank else None, total=sum(by_status.values()),
                by_status={str(getattr(k, "value", k)): v for k, v in by_status.items()},
                by_coach_class={str(getattr(k, "value", k)): v for k, v in by_class.items()}, questions=questions)


def psi_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date, bank_id: uuid.UUID | None) -> list[dict]:
    """Weighted, scale-normalised index per journey: sum(w * (avg - min)/(max - min)) / sum(w) * 100.
    Only available when every question of the bank has an approved psi_weight."""
    divisions = _divisions(p, division_id)
    bank = _bank_for(db, divisions, "passenger", bank_id)
    if bank is None:
        return []
    if not bank.questions or any(q.psi_weight is None for q in bank.questions):
        raise Conflict("PSI weights are not configured for this question bank", code="psi_not_configured")
    span = float(bank.scale_max - bank.scale_min)
    per_q = (select(PassengerFeedback.journey_id.label("journey_id"), PassengerFeedbackRating.question_id.label("qid"),
                    func.avg(PassengerFeedbackRating.value).label("avg"))
             .join(PassengerFeedback, PassengerFeedback.id == PassengerFeedbackRating.feedback_id)
             .where(PassengerFeedback.bank_id == bank.id, PassengerFeedback.division_id.in_(divisions),
                    PassengerFeedback.status == PassengerFeedbackStatus.COMPLETED,
                    PassengerFeedback.feedback_date.between(date_from, date_to))
             .group_by(PassengerFeedback.journey_id, PassengerFeedbackRating.question_id).subquery())
    score = func.sum(Question.psi_weight * (per_q.c.avg - bank.scale_min) / literal(span)) / func.sum(Question.psi_weight) * 100
    responses = (select(func.count()).where(PassengerFeedback.journey_id == Journey.id, PassengerFeedback.bank_id == bank.id,
                                            PassengerFeedback.status == PassengerFeedbackStatus.COMPLETED,
                                            PassengerFeedback.feedback_date.between(date_from, date_to))
                 .correlate(Journey).scalar_subquery())
    rows = db.execute(select(Journey.id, Train.train_no, Journey.journey_date, responses, score)
                      .join(per_q, per_q.c.journey_id == Journey.id).join(Question, Question.id == per_q.c.qid)
                      .join(Train, Train.id == Journey.train_id)
                      .group_by(Journey.id, Train.train_no, Journey.journey_date).order_by(Journey.journey_date)).all()
    return [dict(journey_id=r[0], train_no=r[1], journey_date=r[2], responses=r[3], psi=round(float(r[4]), 2)) for r in rows]


# ---- complaints / inventory --------------------------------------------------------------------------------


def complaint_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date) -> dict:
    divisions = _divisions(p, division_id)
    start, end = _range(date_from, date_to)
    scope = (Complaint.division_id.in_(divisions), Complaint.server_timestamp >= start, Complaint.server_timestamp < end)
    by_status = dict(db.execute(select(Complaint.status, func.count()).where(*scope).group_by(Complaint.status)).all())
    overdue = db.scalar(select(func.count()).where(*scope, Complaint.status != ComplaintStatus.COMPLETED, Complaint.due_at < utcnow()))
    by_cat = [dict(category_id=r[0], category=r[1], total=r[2], open=r[3]) for r in db.execute(
        select(ComplaintCategory.id, ComplaintCategory.name, func.count(),
               func.count().filter(Complaint.status != ComplaintStatus.COMPLETED))
        .join(ComplaintCategory, ComplaintCategory.id == Complaint.category_id).where(*scope)
        .group_by(ComplaintCategory.id, ComplaintCategory.name).order_by(func.count().desc()))]
    avg_hours = db.scalar(select(func.avg(hours_between(db, Complaint.closed_at, Complaint.server_timestamp)))
                          .where(*scope, Complaint.closed_at.is_not(None)))
    return dict(total=sum(by_status.values()), by_status={k.value: v for k, v in by_status.items()}, overdue=overdue,
                by_category=by_cat, avg_resolution_hours=round(float(avg_hours), 2) if avg_hours is not None else None)


def inventory_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date) -> list[dict]:
    divisions = _divisions(p, division_id)
    issued = func.sum(case((InventoryTransaction.txn_type == InventoryTxnType.ISSUE, InventoryTransaction.quantity), else_=0))
    returned = func.sum(case((InventoryTransaction.txn_type == InventoryTxnType.RETURN, InventoryTransaction.quantity), else_=0))
    rows = db.execute(select(InventoryItem.id, InventoryItem.name, InventoryItem.unit, issued, returned,
                             func.count(distinct(InventoryTransaction.journey_id)))
                      .join(InventoryItem, InventoryItem.id == InventoryTransaction.item_id)
                      .join(Journey, Journey.id == InventoryTransaction.journey_id)
                      .where(_journeys_in(divisions, date_from, date_to))
                      .group_by(InventoryItem.id, InventoryItem.name, InventoryItem.unit).order_by(InventoryItem.name)).all()
    return [dict(item_id=r[0], item_name=r[1], unit=r[2].value, issued=float(r[3]), returned=float(r[4]),
                 consumed=float(r[3]) - float(r[4]), journeys=r[5]) for r in rows]


# ---- dashboard ---------------------------------------------------------------------------------------------


def division_dashboard(db: Session, p: Principal, division_id: uuid.UUID) -> dict:
    p.require("dashboard.read", division_id)
    today = today_ist()
    start, end = _range(today, today)
    in_div = Journey.division_id == division_id
    active = db.scalar(select(func.count()).where(in_div, state_clause(JourneyState.ACTIVE, today)))
    scheduled = db.scalar(select(func.count()).where(in_div, state_clause(JourneyState.SCHEDULED, today)))

    def today_count(model, ts_col, *extra):
        return db.scalar(select(func.count()).where(model.division_id == division_id, ts_col >= start, ts_col < end, *extra))

    now = utcnow()
    return dict(
        division_id=division_id, date=today, journeys_active=active, journeys_scheduled=scheduled,
        attendance_today=today_count(Attendance, Attendance.device_timestamp),
        inspections_today=today_count(Inspection, Inspection.device_timestamp),
        passenger_feedback_today=today_count(PassengerFeedback, PassengerFeedback.server_timestamp, PassengerFeedback.status.in_(COUNTED)),
        railway_feedback_today=today_count(RailwayFeedback, RailwayFeedback.server_timestamp),
        complaints_open=db.scalar(select(func.count()).where(Complaint.division_id == division_id, Complaint.status != ComplaintStatus.COMPLETED)),
        complaints_overdue=db.scalar(select(func.count()).where(Complaint.division_id == division_id,
                                                                Complaint.status != ComplaintStatus.COMPLETED, Complaint.due_at < now)),
    )


def map_points(db: Session, p: Principal, division_id: uuid.UUID, kind: str, on: date) -> list[dict]:
    """Geo points for map views (latest attendance per employee, or counted passenger feedback) on one IST day."""
    p.require("dashboard.read", division_id)
    start, end = _range(on, on)
    if kind == "attendance":
        latest = (select(Attendance.employee_id, func.max(Attendance.device_timestamp).label("ts"))
                  .where(Attendance.division_id == division_id, Attendance.device_timestamp >= start, Attendance.device_timestamp < end)
                  .group_by(Attendance.employee_id).subquery())
        rows = db.execute(select(Attendance.id, Attendance.journey_id, Attendance.employee_id, Attendance.stage,
                                 Attendance.latitude, Attendance.longitude, Attendance.device_timestamp)
                          .join(latest, and_(latest.c.employee_id == Attendance.employee_id, latest.c.ts == Attendance.device_timestamp))
                          .where(Attendance.division_id == division_id)).all()
        return [dict(id=r[0], journey_id=r[1], employee_id=r[2], stage=r[3], latitude=r[4], longitude=r[5], at=r[6]) for r in rows]
    if kind == "feedback":
        rows = db.execute(select(PassengerFeedback.id, PassengerFeedback.journey_id, PassengerFeedback.coach_code,
                                 PassengerFeedback.latitude, PassengerFeedback.longitude, PassengerFeedback.device_timestamp)
                          .where(PassengerFeedback.division_id == division_id, PassengerFeedback.status.in_(COUNTED),
                                 PassengerFeedback.device_timestamp >= start, PassengerFeedback.device_timestamp < end)
                          .limit(5000)).all()
        return [dict(id=r[0], journey_id=r[1], coach_code=r[2], latitude=r[3], longitude=r[4], at=r[5]) for r in rows]
    raise BusinessRuleViolation("kind must be attendance or feedback")
