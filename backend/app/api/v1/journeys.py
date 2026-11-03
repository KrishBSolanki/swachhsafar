import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import JourneyState
from app.schemas.common import Page, PageParams
from app.schemas.journeys import (
    JourneyCancel,
    JourneyCreate,
    JourneyDetail,
    JourneyOut,
    JourneyUpdate,
    StaffAdd,
    StaffOut,
    SupervisorAssign,
)
from app.schemas.reports import JourneySummary
from app.security.principal import Principal, get_principal
from app.services import journeys as svc
from app.services import reports

router = APIRouter(prefix="/journeys", tags=["journeys"])
staff_router = APIRouter(prefix="/staff-allocation", tags=["staff-allocation"])


def _detail(db: Session, p: Principal, journey_id: uuid.UUID) -> dict:
    j = svc.get_journey(db, p, journey_id)
    return {**svc.to_out(j), "staff": svc.list_staff(db, p, journey_id)}


@router.get("", response_model=Page[JourneyOut])
def list_journeys(params: PageParams = Depends(), state: JourneyState | None = None, division_id: uuid.UUID | None = None,
                  train_id: uuid.UUID | None = None, supervisor_id: uuid.UUID | None = None, date_from: date | None = None,
                  date_to: date | None = None, mine: bool = False, updated_since: datetime | None = None,
                  db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """`state` = active | scheduled | history | cancelled, derived from IST dates and cancellation."""
    items, total = svc.list_journeys(db, p, params, state=state, division_id=division_id, train_id=train_id,
                                     supervisor_id=supervisor_id, date_from=date_from, date_to=date_to, mine=mine,
                                     updated_since=updated_since)
    return Page(items=[svc.to_out(j) for j in items], total=total, page=params.page, page_size=params.page_size)


@router.post("", response_model=JourneyDetail, status_code=status.HTTP_201_CREATED)
def create_journey(body: JourneyCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    j = svc.create_journey(db, p, body)
    return _detail(db, p, j.id)


@router.get("/{journey_id}", response_model=JourneyDetail)
def get_journey(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return _detail(db, p, journey_id)


@router.patch("/{journey_id}", response_model=JourneyDetail)
def update_journey(journey_id: uuid.UUID, body: JourneyUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    svc.update_journey(db, p, journey_id, body)
    return _detail(db, p, journey_id)


@router.post("/{journey_id}/supervisor", response_model=JourneyDetail)
def assign_supervisor(journey_id: uuid.UUID, body: SupervisorAssign, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    svc.assign_supervisor(db, p, journey_id, body)
    return _detail(db, p, journey_id)


@router.post("/{journey_id}/cancel", response_model=JourneyDetail)
def cancel_journey(journey_id: uuid.UUID, body: JourneyCancel, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    svc.cancel_journey(db, p, journey_id, body)
    return _detail(db, p, journey_id)


@router.get("/{journey_id}/summary", response_model=JourneySummary)
def journey_summary(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return reports.journey_summary(db, p, journey_id)


@staff_router.get("/{journey_id}", response_model=list[StaffOut])
def list_staff(journey_id: uuid.UUID, include_removed: bool = False, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_staff(db, p, journey_id, include_removed)


@staff_router.post("/{journey_id}", response_model=list[StaffOut])
def add_staff(journey_id: uuid.UUID, body: StaffAdd, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.add_staff(db, p, journey_id, body)


@staff_router.delete("/{journey_id}/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def remove_staff(journey_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    svc.remove_staff(db, p, journey_id, user_id)
