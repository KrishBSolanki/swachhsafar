import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.sqlcompat import is_unique_violation
from sqlalchemy.orm import Session, selectinload

from app.config import get_settings
from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound, ServiceUnavailable
from app.models import (
    CoachClass,
    Journey,
    MediaKind,
    OtpChallenge,
    OtpStatus,
    PassengerFeedback,
    PassengerFeedbackRating,
    PassengerFeedbackStatus,
    PnrStatus,
    Question,
    QuestionBank,
    RailwayFeedback,
    RailwayFeedbackRating,
    User,
    UserStatus,
)
from app.providers.external import PnrProvider, ProviderUnavailable, SmsProvider
from app.schemas.common import PageParams
from app.schemas.feedback import (
    OtpVerify,
    PassengerFeedbackComplete,
    PassengerFeedbackStart,
    QuestionBankCreate,
    Rating,
    RailwayFeedbackIn,
    VoidIn,
)
from app.schemas.operations import ReviewIn
from app.security.principal import Principal
from app.services import media
from app.services.common import audit, check_replay, get_or_404, paginate, payload_hash
from app.services.inspections import day_is_open
from app.services.journeys import check_capture_window, get_journey, is_allocated
from app.services.policy import get_policy
from app.timeutil import utcnow

COUNTED = (PassengerFeedbackStatus.VERIFIED, PassengerFeedbackStatus.COMPLETED)

# ---- question banks ----------------------------------------------------------------------------------------


def create_bank(db: Session, p: Principal, body: QuestionBankCreate) -> QuestionBank:
    if body.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can define default question banks", code="permission_denied")
    else:
        p.require("questions.manage", body.division_id)
    bank = QuestionBank(division_id=body.division_id, audience=body.audience, name=body.name, scale_min=body.scale_min,
                        scale_max=body.scale_max, is_active=False,
                        questions=[Question(position=i, **q.model_dump()) for i, q in enumerate(body.questions, 1)])
    db.add(bank)
    db.flush()
    audit(db, actor_id=p.id, action="question_bank.create", entity=bank, division_id=body.division_id, changes=body.model_dump(mode="json"))
    db.commit()
    return bank


def activate_bank(db: Session, p: Principal, bank_id: uuid.UUID) -> QuestionBank:
    """Banks are immutable versions; activating one retires the previously active bank for the same scope."""
    bank = get_or_404(db, QuestionBank, bank_id, "Question bank")
    if bank.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can activate default question banks", code="permission_denied")
    else:
        p.require("questions.manage", bank.division_id)
    scope = QuestionBank.division_id.is_(None) if bank.division_id is None else QuestionBank.division_id == bank.division_id
    db.execute(update(QuestionBank).where(scope, QuestionBank.audience == bank.audience, QuestionBank.id != bank.id)
               .values(is_active=False))
    bank.is_active = True
    audit(db, actor_id=p.id, action="question_bank.activate", entity=bank, division_id=bank.division_id)
    db.commit()
    return bank


def list_banks(db: Session, p: Principal, division_id: uuid.UUID | None) -> list[QuestionBank]:
    stmt = select(QuestionBank).options(selectinload(QuestionBank.questions)).order_by(QuestionBank.created_at.desc())
    if division_id is None:
        stmt = stmt.where(QuestionBank.division_id.is_(None))
    else:
        if not p.can_access_division(division_id):
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        stmt = stmt.where(QuestionBank.division_id == division_id)
    return list(db.scalars(stmt))


def active_bank(db: Session, division_id: uuid.UUID, audience: str) -> QuestionBank:
    for scope in (QuestionBank.division_id == division_id, QuestionBank.division_id.is_(None)):
        bank = db.scalar(select(QuestionBank).where(scope, QuestionBank.audience == audience, QuestionBank.is_active.is_(True)))
        if bank is not None:
            return bank
    raise BusinessRuleViolation(f"No active {audience} question bank is configured", code="no_question_bank")


def applicable(bank: QuestionBank, coach_class: CoachClass | None) -> list[Question]:
    if coach_class is None:
        return list(bank.questions)
    return [q for q in bank.questions if (q.applies_ac if coach_class == CoachClass.AC else q.applies_non_ac)]


def _validate_ratings(bank: QuestionBank, coach_class: CoachClass | None, ratings: list[Rating]) -> None:
    questions = {q.id: q for q in applicable(bank, coach_class)}
    unknown = [str(r.question_id) for r in ratings if r.question_id not in questions]
    if unknown:
        raise BusinessRuleViolation("Ratings for questions that do not apply", code="invalid_question", details=unknown)
    missing = [str(qid) for qid, q in questions.items() if q.required and qid not in {r.question_id for r in ratings}]
    if missing:
        raise BusinessRuleViolation("Required questions not rated", code="missing_rating", details=missing)
    bad = [str(r.question_id) for r in ratings if not bank.scale_min <= r.value <= bank.scale_max]
    if bad:
        raise BusinessRuleViolation(f"Ratings must be between {bank.scale_min} and {bank.scale_max}", code="rating_range", details=bad)


# ---- shared checks -----------------------------------------------------------------------------------------


def _require_journey_staff(db: Session, p: Principal, j: Journey) -> None:
    if not (j.supervisor_id == p.id or is_allocated(db, j.id, p.id) or p.has("feedback.review", j.division_id)):
        raise Forbidden("Only journey staff may collect feedback for this journey", code="not_journey_staff")


def _coach(j: Journey, code: str):
    coach = next((c for c in j.coaches if c.code == code), None)
    if coach is None:
        raise BusinessRuleViolation("Coach is not part of this journey", code="unknown_coach")
    return coach


def _load_feedback(db: Session, p: Principal, feedback_id: uuid.UUID, *, for_update: bool = False) -> PassengerFeedback:
    stmt = select(PassengerFeedback).where(PassengerFeedback.id == feedback_id)
    if for_update:
        stmt = stmt.with_for_update()
    fb = db.scalar(stmt)
    if fb is None or not p.can_access_division(fb.division_id):
        raise NotFound("Feedback not found")
    if fb.collected_by_id != p.id and not p.has("feedback.read", fb.division_id):
        raise NotFound("Feedback not found")
    return fb


def _require_collector(p: Principal, fb: PassengerFeedback) -> None:
    if fb.collected_by_id != p.id:
        raise Forbidden("Only the collecting staff member can continue this feedback", code="not_collector")


def _maybe_verified(fb: PassengerFeedback) -> None:
    pnr_ok = fb.pnr_status in (PnrStatus.VALID, PnrStatus.NOT_REQUIRED)
    otp_ok = fb.otp_status in (OtpStatus.VERIFIED, OtpStatus.NOT_REQUIRED)
    if fb.status == PassengerFeedbackStatus.DRAFT and pnr_ok and otp_ok:
        fb.status = PassengerFeedbackStatus.VERIFIED
        fb.verified_at = utcnow()


def _duplicate_checks(db: Session, fb_id: uuid.UUID, journey_id: uuid.UUID, pnr: str | None, mobile: str, feedback_date,
                      coach_code: str, day: int, per_coach_day: int | None) -> None:
    counted = PassengerFeedback.status.in_(COUNTED)
    others = (PassengerFeedback.journey_id == journey_id, PassengerFeedback.id != fb_id, counted)
    if pnr and db.scalar(select(func.count()).where(*others, PassengerFeedback.pnr == pnr)):
        raise Conflict("Feedback already recorded for this PNR on this journey", code="duplicate_pnr")
    if db.scalar(select(func.count()).where(*others, PassengerFeedback.mobile == mobile,
                                            PassengerFeedback.feedback_date == feedback_date)):
        raise Conflict("Feedback already recorded from this mobile today on this journey", code="duplicate_mobile")
    if per_coach_day and db.scalar(select(func.count()).where(*others, PassengerFeedback.coach_code == coach_code,
                                                             PassengerFeedback.journey_day == day)) >= per_coach_day:
        raise Conflict("Feedback limit reached for this coach and day", code="coach_day_limit")


def _commit_transition(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if is_unique_violation(exc):
            raise Conflict("Another verified feedback already uses this PNR or mobile", code="duplicate_feedback") from exc
        raise


# ---- passenger workflow ------------------------------------------------------------------------------------


def start_passenger(db: Session, p: Principal, body: PassengerFeedbackStart) -> tuple[PassengerFeedback, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, PassengerFeedback, body.id, digest, "collected_by_id", p.id)) is not None:
        return existing, True
    j = get_journey(db, p, body.journey_id)
    p.require("feedback.collect", j.division_id)
    _require_journey_staff(db, p, j)
    policy = get_policy(db, j.division_id)
    captured_on = check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    coach = _coach(j, body.coach_code)
    if body.journey_day > j.operational_days or not day_is_open(j, body.journey_day, captured_on):
        raise BusinessRuleViolation("Feedback is not open for this journey day", code="day_not_open")
    if policy.passenger_pnr_required and not body.pnr:
        raise BusinessRuleViolation("PNR is required", code="pnr_required")
    if db.scalar(select(User.id).where(User.mobile == body.mobile, User.status != UserStatus.DELETED)):
        raise BusinessRuleViolation("Staff mobile numbers cannot give passenger feedback", code="staff_mobile")
    _duplicate_checks(db, body.id, j.id, body.pnr, body.mobile, captured_on, coach.code, body.journey_day,
                      policy.passenger_feedback_per_coach_day)
    bank = active_bank(db, j.division_id, "passenger")
    fb = PassengerFeedback(
        **body.model_dump(), division_id=j.division_id, bank_id=bank.id, coach_class=coach.classification,
        feedback_date=captured_on, collected_by_id=p.id, payload_hash=digest, status=PassengerFeedbackStatus.DRAFT,
        pnr_status=PnrStatus.PENDING if policy.passenger_pnr_required else PnrStatus.NOT_REQUIRED,
        otp_status=OtpStatus.NOT_SENT if policy.passenger_otp_required else OtpStatus.NOT_REQUIRED,
    )
    _maybe_verified(fb)
    db.add(fb)
    db.flush()
    audit(db, actor_id=p.id, action="feedback.passenger.start", entity=fb, division_id=j.division_id,
          changes={"coach": fb.coach_code, "day": fb.journey_day, "pnr_status": fb.pnr_status, "otp_status": fb.otp_status})
    _commit_transition(db)
    return fb, False


def verify_pnr(db: Session, p: Principal, provider: PnrProvider, feedback_id: uuid.UUID) -> PassengerFeedback:
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status != PassengerFeedbackStatus.DRAFT or fb.pnr_status != PnrStatus.PENDING:
        raise BusinessRuleViolation("PNR verification is not pending for this feedback", code="invalid_state")
    j = db.get(Journey, fb.journey_id)
    policy = get_policy(db, fb.division_id)
    try:
        result = provider.lookup(fb.pnr)
    except ProviderUnavailable as exc:
        raise ServiceUnavailable("PNR service unavailable; feedback remains pending", code="pnr_unavailable") from exc

    reason = None
    if not result.found:
        reason = "PNR not found"
    else:
        trains = _expected_train_numbers(j, fb.journey_day, policy.pnr_train_day_mapping)
        if result.train_number not in trains:
            reason = "PNR is for a different train"
        elif policy.pnr_coach_match_required and fb.coach_code.replace(" ", "") not in {c.replace(" ", "") for c in result.coach_ids}:
            reason = "PNR coach does not match"
    fb.pnr_checked_at = utcnow()
    fb.pnr_details = {"found": result.found, "train_number": result.train_number, "train_name": result.train_name,
                      "coach_ids": sorted(result.coach_ids), "status": result.status_text}
    if reason:
        fb.pnr_status = PnrStatus.INVALID
        fb.status = PassengerFeedbackStatus.VOID
        fb.void_reason = reason
    else:
        fb.pnr_status = PnrStatus.VALID
        _maybe_verified(fb)
    audit(db, actor_id=p.id, action="feedback.passenger.pnr", entity=fb, division_id=fb.division_id,
          changes={"pnr_status": fb.pnr_status, "reason": reason})
    _commit_transition(db)
    return fb


def _expected_train_numbers(j: Journey, day: int, day_mapping: bool) -> set[str]:
    def numbers(train) -> set[str]:
        return {n.strip() for n in train.train_no.split("/")} if train else set()

    main, linked = numbers(j.train), numbers(j.linked_train)
    if not day_mapping or not linked:
        return main | linked
    return main if day <= (j.operational_days + 1) // 2 else linked


def _otp_hash(feedback_id: uuid.UUID, code: str) -> str:
    pepper = get_settings().otp_pepper.get_secret_value().encode()
    return hmac.new(pepper, f"{feedback_id}:{code}".encode(), hashlib.sha256).hexdigest()


def send_otp(db: Session, p: Principal, sms: SmsProvider, feedback_id: uuid.UUID) -> dict:
    settings = get_settings()
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status != PassengerFeedbackStatus.DRAFT or fb.otp_status not in (OtpStatus.NOT_SENT, OtpStatus.SENT):
        raise BusinessRuleViolation("OTP cannot be sent in the current state", code="invalid_state")
    if fb.pnr_status == PnrStatus.PENDING:
        raise BusinessRuleViolation("Verify the PNR before sending the OTP", code="pnr_pending")
    now = utcnow()
    challenge = db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == fb.id))
    if challenge is not None:
        if challenge.send_count >= settings.otp_max_sends:
            raise BusinessRuleViolation("OTP resend limit reached", code="otp_send_limit")
        wait_until = challenge.last_sent_at + timedelta(seconds=settings.otp_resend_cooldown_seconds)
        if now < wait_until:
            raise BusinessRuleViolation("Please wait before requesting another OTP", code="otp_cooldown",
                                        details={"resend_available_at": wait_until.isoformat()})
    code = f"{secrets.randbelow(1_000_000):06d}"
    try:
        sms.send_otp(fb.mobile, code)
    except ProviderUnavailable as exc:
        db.rollback()
        raise ServiceUnavailable("SMS service unavailable; try again later", code="sms_unavailable") from exc
    expires = now + timedelta(seconds=settings.otp_ttl_seconds)
    if challenge is None:
        challenge = OtpChallenge(feedback_id=fb.id, mobile=fb.mobile, code_hash=_otp_hash(fb.id, code), expires_at=expires,
                                 attempts=0, send_count=1, last_sent_at=now)
        db.add(challenge)
    else:
        challenge.code_hash = _otp_hash(fb.id, code)
        challenge.expires_at = expires
        challenge.attempts = 0
        challenge.send_count += 1
        challenge.last_sent_at = now
    fb.otp_status = OtpStatus.SENT
    audit(db, actor_id=p.id, action="feedback.passenger.otp_sent", entity=fb, division_id=fb.division_id,
          changes={"send_count": challenge.send_count})
    db.commit()
    return dict(otp_status=fb.otp_status, expires_at=expires,
                resend_available_at=now + timedelta(seconds=settings.otp_resend_cooldown_seconds),
                sends_remaining=settings.otp_max_sends - challenge.send_count, mobile_masked=fb.mobile_masked)


def verify_otp(db: Session, p: Principal, feedback_id: uuid.UUID, body: OtpVerify) -> PassengerFeedback:
    settings = get_settings()
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.otp_status != OtpStatus.SENT or fb.status != PassengerFeedbackStatus.DRAFT:
        raise BusinessRuleViolation("No OTP is awaiting verification", code="invalid_state")
    challenge = db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == fb.id).with_for_update())
    if utcnow() > challenge.expires_at:
        raise BusinessRuleViolation("OTP expired; request a new one", code="otp_expired")
    challenge.attempts += 1
    if not hmac.compare_digest(challenge.code_hash, _otp_hash(fb.id, body.code)):
        if challenge.attempts >= settings.otp_max_attempts:
            fb.otp_status = OtpStatus.LOCKED
            fb.status = PassengerFeedbackStatus.VOID
            fb.void_reason = "Too many incorrect OTP attempts"
        audit(db, actor_id=p.id, action="feedback.passenger.otp_failed", entity=fb, division_id=fb.division_id,
              changes={"attempts": challenge.attempts})
        db.commit()
        if fb.otp_status == OtpStatus.LOCKED:
            raise BusinessRuleViolation("Too many incorrect attempts; feedback voided", code="otp_locked")
        raise BusinessRuleViolation("Incorrect OTP", code="otp_invalid",
                                    details={"attempts_remaining": settings.otp_max_attempts - challenge.attempts})
    challenge.verified_at = utcnow()
    fb.otp_status = OtpStatus.VERIFIED
    _maybe_verified(fb)
    audit(db, actor_id=p.id, action="feedback.passenger.otp_verified", entity=fb, division_id=fb.division_id)
    _commit_transition(db)
    return fb


def complete_passenger(db: Session, p: Principal, feedback_id: uuid.UUID, body: PassengerFeedbackComplete) -> PassengerFeedback:
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status == PassengerFeedbackStatus.COMPLETED:
        if sorted((r.question_id, r.value) for r in fb.ratings) == sorted((r.question_id, r.value) for r in body.ratings):
            return fb  # idempotent replay
        raise Conflict("Feedback already completed", code="already_completed")
    if fb.status != PassengerFeedbackStatus.VERIFIED:
        raise BusinessRuleViolation("Feedback must be verified before ratings are submitted", code="not_verified",
                                    details={"pnr_status": fb.pnr_status, "otp_status": fb.otp_status})
    bank = db.get(QuestionBank, fb.bank_id)
    _validate_ratings(bank, fb.coach_class, body.ratings)
    fb.voice_media_id = media.claim(db, body.voice_media_id, MediaKind.FEEDBACK_VOICE, fb.division_id, p.id,
                                    required=False, label="Voice recording")
    fb.ratings = [PassengerFeedbackRating(question_id=r.question_id, value=r.value) for r in body.ratings]
    fb.comments = body.comments
    fb.status = PassengerFeedbackStatus.COMPLETED
    fb.completed_at = utcnow()
    audit(db, actor_id=p.id, action="feedback.passenger.complete", entity=fb, division_id=fb.division_id)
    _commit_transition(db)
    return fb


def void_passenger(db: Session, p: Principal, feedback_id: uuid.UUID, body: VoidIn) -> PassengerFeedback:
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    if fb.status == PassengerFeedbackStatus.VOID:
        return fb
    own_draft = fb.collected_by_id == p.id and fb.status == PassengerFeedbackStatus.DRAFT
    if not own_draft:
        p.require("feedback.review", fb.division_id)
    audit(db, actor_id=p.id, action="feedback.passenger.void", entity=fb, division_id=fb.division_id,
          changes={"from": fb.status, "reason": body.reason})
    fb.status = PassengerFeedbackStatus.VOID
    fb.void_reason = body.reason
    db.commit()
    return fb


def get_passenger(db: Session, p: Principal, feedback_id: uuid.UUID) -> PassengerFeedback:
    return _load_feedback(db, p, feedback_id)


def list_passenger(db: Session, p: Principal, params: PageParams, *, journey_id, status, coach_code, journey_day):
    divisions = p.require_any_division("feedback.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = (select(PassengerFeedback).options(selectinload(PassengerFeedback.ratings))
            .join(Journey, Journey.id == PassengerFeedback.journey_id)
            .where(PassengerFeedback.division_id.in_(divisions),
                   or_(PassengerFeedback.division_id.in_(full), PassengerFeedback.collected_by_id == p.id,
                       Journey.supervisor_id == p.id)))
    for col, val in ((PassengerFeedback.journey_id, journey_id), (PassengerFeedback.status, status),
                     (PassengerFeedback.coach_code, coach_code), (PassengerFeedback.journey_day, journey_day)):
        if val is not None:
            stmt = stmt.where(col == val)
    return paginate(db, stmt.order_by(PassengerFeedback.server_timestamp.desc(), PassengerFeedback.id), params)


# ---- railway workflow --------------------------------------------------------------------------------------


def create_railway(db: Session, p: Principal, body: RailwayFeedbackIn, *, commit: bool = True) -> tuple[RailwayFeedback, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, RailwayFeedback, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True
    j = get_journey(db, p, body.journey_id, for_update=True)  # lock serialises the per-journey limit check
    p.require("feedback.railway.submit", j.division_id)
    _require_journey_staff(db, p, j)
    policy = get_policy(db, j.division_id)
    captured_on = check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    if body.journey_day > j.operational_days or not day_is_open(j, body.journey_day, captured_on):
        raise BusinessRuleViolation("Feedback is not open for this journey day", code="day_not_open")
    coach_class = _coach(j, body.coach_code).classification if body.coach_code else None
    used = db.scalar(select(func.count()).where(RailwayFeedback.journey_id == j.id,
                                                RailwayFeedback.verification_status != "rejected"))
    if used >= policy.railway_feedback_limit_per_journey:
        raise Conflict(f"Railway feedback limit ({policy.railway_feedback_limit_per_journey}) reached for this journey",
                       code="railway_feedback_limit")
    bank = active_bank(db, j.division_id, "railway")
    _validate_ratings(bank, coach_class, body.ratings)
    fb = RailwayFeedback(**body.model_dump(exclude={"ratings"}), division_id=j.division_id, bank_id=bank.id,
                         created_by_id=p.id, payload_hash=digest,
                         ratings=[RailwayFeedbackRating(question_id=r.question_id, value=r.value) for r in body.ratings])
    db.add(fb)
    db.flush()
    audit(db, actor_id=p.id, action="feedback.railway.create", entity=fb, division_id=j.division_id,
          changes={"railway_employee_id": body.railway_employee_id, "day": body.journey_day})
    if commit:
        db.commit()
    return fb, False


def review_railway(db: Session, p: Principal, feedback_id: uuid.UUID, body: ReviewIn) -> RailwayFeedback:
    fb = get_or_404(db, RailwayFeedback, feedback_id, "Feedback")
    p.require("feedback.review", fb.division_id)
    if fb.created_by_id == p.id:
        raise Forbidden("You cannot review feedback you recorded", code="self_review")
    audit(db, actor_id=p.id, action="feedback.railway.review", entity=fb, division_id=fb.division_id,
          changes={"status": {"from": fb.verification_status, "to": body.status.value}, "remarks": body.remarks})
    fb.verification_status = body.status.value
    fb.verified_by_id = p.id
    fb.verified_at = utcnow()
    db.commit()
    return fb


def list_railway(db: Session, p: Principal, params: PageParams, *, journey_id):
    divisions = p.require_any_division("feedback.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = (select(RailwayFeedback).options(selectinload(RailwayFeedback.ratings))
            .join(Journey, Journey.id == RailwayFeedback.journey_id)
            .where(RailwayFeedback.division_id.in_(divisions),
                   or_(RailwayFeedback.division_id.in_(full), RailwayFeedback.created_by_id == p.id, Journey.supervisor_id == p.id)))
    if journey_id:
        stmt = stmt.where(RailwayFeedback.journey_id == journey_id)
    return paginate(db, stmt.order_by(RailwayFeedback.server_timestamp.desc(), RailwayFeedback.id), params)

