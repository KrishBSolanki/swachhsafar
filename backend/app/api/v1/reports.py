import uuid
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.reports import (
    AttendanceRow,
    ComplaintReport,
    DivisionDashboard,
    FeedbackReport,
    InspectionRow,
    InventoryRow,
    PsiRow,
)
from app.security.principal import Principal, get_principal
from app.services import reports as svc
from app.timeutil import today_ist

router = APIRouter(prefix="/reports", tags=["reports"])
dashboard_router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/attendance", response_model=list[AttendanceRow])
def attendance(date_from: date, date_to: date, group_by: Literal["employee", "journey"] = "employee",
               division_id: uuid.UUID | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.attendance_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, group_by=group_by)


@router.get("/inspections", response_model=list[InspectionRow])
def inspections(date_from: date, date_to: date, coach_wise: bool = False, division_id: uuid.UUID | None = None,
                db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.inspection_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, coach_wise=coach_wise)


@router.get("/feedback/{audience}", response_model=FeedbackReport)
def feedback(audience: Literal["passenger", "railway"], date_from: date, date_to: date, division_id: uuid.UUID | None = None,
             journey_id: uuid.UUID | None = None, bank_id: uuid.UUID | None = None,
             db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Counts and per-question raw averages on the bank's own scale (no percentage conversion is assumed)."""
    return svc.feedback_report(db, p, audience=audience, division_id=division_id, date_from=date_from, date_to=date_to,
                               journey_id=journey_id, bank_id=bank_id)


@router.get("/psi", response_model=list[PsiRow], responses={409: {"description": "PSI weights not configured"}})
def psi(date_from: date, date_to: date, division_id: uuid.UUID | None = None, bank_id: uuid.UUID | None = None,
        db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.psi_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, bank_id=bank_id)


@router.get("/complaints", response_model=ComplaintReport)
def complaints(date_from: date, date_to: date, division_id: uuid.UUID | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.complaint_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to)


@router.get("/inventory", response_model=list[InventoryRow])
def inventory(date_from: date, date_to: date, division_id: uuid.UUID | None = None,
              db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.inventory_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to)


class MapPoint(BaseModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    latitude: float
    longitude: float
    at: datetime
    employee_id: uuid.UUID | None = None
    stage: int | None = None
    coach_code: str | None = None


@dashboard_router.get("/divisions/{division_id}", response_model=DivisionDashboard)
def division_dashboard(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.division_dashboard(db, p, division_id)


@dashboard_router.get("/divisions/{division_id}/map", response_model=list[MapPoint])
def map_points(division_id: uuid.UUID, kind: Literal["attendance", "feedback"], on: date | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.map_points(db, p, division_id, kind, on or today_ist())
