import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import PassengerFeedbackStatus
from app.providers.external import PnrProvider, SmsProvider, get_pnr_provider, get_sms_provider
from app.schemas.common import Page, PageParams
from app.schemas.feedback import (
    OtpSent,
    OtpVerify,
    PassengerFeedbackComplete,
    PassengerFeedbackOut,
    PassengerFeedbackStart,
    QuestionBankCreate,
    QuestionBankOut,
    QuestionOut,
    RailwayFeedbackIn,
    RailwayFeedbackOut,
    VoidIn,
)
from app.schemas.operations import ReviewIn
from app.security.principal import Principal, get_principal
from app.security.ratelimit import rate_limit
from app.services import feedback as svc
from app.services.journeys import get_journey

router = APIRouter(prefix="/feedback", tags=["feedback"])


@router.post("/question-banks", response_model=QuestionBankOut, status_code=status.HTTP_201_CREATED)
def create_bank(body: QuestionBankCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_bank(db, p, body)


@router.get("/question-banks", response_model=list[QuestionBankOut])
def list_banks(division_id: uuid.UUID | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_banks(db, p, division_id)


@router.post("/question-banks/{bank_id}/activate", response_model=QuestionBankOut)
def activate_bank(bank_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.activate_bank(db, p, bank_id)


@router.get("/questions", response_model=list[QuestionOut])
def questions_for(journey_id: uuid.UUID, audience: str = "passenger", coach_code: str | None = None,
                  db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Questions that apply to a journey's division and (optionally) a coach's AC/Non-AC class."""
    j = get_journey(db, p, journey_id)
    bank = svc.active_bank(db, j.division_id, audience)
    coach_class = next((c.classification for c in j.coaches if c.code == coach_code), None) if coach_code else None
    return svc.applicable(bank, coach_class)


# ---- passenger ---------------------------------------------------------------------------------------------

@router.post("/passenger", response_model=PassengerFeedbackOut, status_code=status.HTTP_201_CREATED)
def start_passenger(body: PassengerFeedbackStart, response: Response, db: Session = Depends(get_db),
                    p: Principal = Depends(get_principal)):
    """Creates a draft. It is not counted until PNR/OTP verification (as required by division policy) succeeds."""
    fb, replayed = svc.start_passenger(db, p, body)
    if replayed:
        response.status_code = status.HTTP_200_OK
    return fb


@router.get("/passenger", response_model=Page[PassengerFeedbackOut])
def list_passenger(params: PageParams = Depends(), journey_id: uuid.UUID | None = None,
                   status_: PassengerFeedbackStatus | None = Query(None, alias="status"), coach_code: str | None = None, journey_day: int | None = None,
                   db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.list_passenger(db, p, params, journey_id=journey_id, status=status_, coach_code=coach_code,
                                      journey_day=journey_day)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/passenger/{feedback_id}", response_model=PassengerFeedbackOut)
def get_passenger(feedback_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.get_passenger(db, p, feedback_id)


@router.post("/passenger/{feedback_id}/verify-pnr", response_model=PassengerFeedbackOut)
def verify_pnr(feedback_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(rate_limit(10, 60)),
               provider: PnrProvider = Depends(get_pnr_provider)):
    return svc.verify_pnr(db, p, provider, feedback_id)


@router.post("/passenger/{feedback_id}/send-otp", response_model=OtpSent)
def send_otp(feedback_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(rate_limit(10, 300)),
             sms: SmsProvider = Depends(get_sms_provider)):
    """Sends a 6-digit code by SMS. The code is never returned by the API."""
    return svc.send_otp(db, p, sms, feedback_id)


@router.post("/passenger/{feedback_id}/verify-otp", response_model=PassengerFeedbackOut)
def verify_otp(feedback_id: uuid.UUID, body: OtpVerify, db: Session = Depends(get_db), p: Principal = Depends(rate_limit(20, 300))):
    return svc.verify_otp(db, p, feedback_id, body)


@router.post("/passenger/{feedback_id}/complete", response_model=PassengerFeedbackOut)
def complete_passenger(feedback_id: uuid.UUID, body: PassengerFeedbackComplete, db: Session = Depends(get_db),
                       p: Principal = Depends(get_principal)):
    return svc.complete_passenger(db, p, feedback_id, body)


@router.post("/passenger/{feedback_id}/void", response_model=PassengerFeedbackOut)
def void_passenger(feedback_id: uuid.UUID, body: VoidIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.void_passenger(db, p, feedback_id, body)


# ---- railway -----------------------------------------------------------------------------------------------

@router.post("/railway", response_model=RailwayFeedbackOut, status_code=status.HTTP_201_CREATED)
def create_railway(body: RailwayFeedbackIn, response: Response, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    fb, replayed = svc.create_railway(db, p, body)
    if replayed:
        response.status_code = status.HTTP_200_OK
    return fb


@router.get("/railway", response_model=Page[RailwayFeedbackOut])
def list_railway(params: PageParams = Depends(), journey_id: uuid.UUID | None = None, db: Session = Depends(get_db),
                 p: Principal = Depends(get_principal)):
    items, total = svc.list_railway(db, p, params, journey_id=journey_id)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("/railway/{feedback_id}/review", response_model=RailwayFeedbackOut)
def review_railway(feedback_id: uuid.UUID, body: ReviewIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.review_railway(db, p, feedback_id, body)
