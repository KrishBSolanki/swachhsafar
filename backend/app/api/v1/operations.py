import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import InspectionPhase, VerificationStatus
from app.schemas.common import Page, PageParams
from app.schemas.operations import (
    AttendanceIn,
    AttendanceOut,
    CoachDayStatus,
    GroupAttendanceIn,
    GroupResult,
    InspectionIn,
    InspectionOut,
    ReviewIn,
    StaffAttendanceStatus,
)
from app.security.principal import Principal, get_principal
from app.services import attendance, inspections

attendance_router = APIRouter(prefix="/attendance", tags=["attendance"])
inspections_router = APIRouter(prefix="/inspections", tags=["inspections"])


def _created(response: Response, replayed: bool) -> None:
    response.status_code = status.HTTP_200_OK if replayed else status.HTTP_201_CREATED
    response.headers["Idempotent-Replayed"] = "true" if replayed else "false"


@attendance_router.post("", response_model=AttendanceOut, status_code=status.HTTP_201_CREATED,
                        responses={200: {"description": "Idempotent replay of an existing record"}})
def create_attendance(body: AttendanceIn, response: Response, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    record, replayed = attendance.create(db, p, body)
    _created(response, replayed)
    return record


@attendance_router.post("/group", response_model=list[GroupResult])
def create_group(body: GroupAttendanceIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return attendance.create_group(db, p, body)


@attendance_router.get("", response_model=Page[AttendanceOut])
def list_attendance(params: PageParams = Depends(), journey_id: uuid.UUID | None = None, employee_id: uuid.UUID | None = None,
                    stage: int | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
                    verification_status: VerificationStatus | None = None,
                    db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = attendance.list_records(db, p, params, journey_id=journey_id, employee_id=employee_id, stage=stage,
                                           date_from=date_from, date_to=date_to, verification_status=verification_status)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@attendance_router.get("/journeys/{journey_id}/status", response_model=list[StaffAttendanceStatus])
def attendance_status(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return attendance.journey_status(db, p, journey_id)


@attendance_router.get("/{attendance_id}", response_model=AttendanceOut)
def get_attendance(attendance_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return attendance.get(db, p, attendance_id)


@attendance_router.post("/{attendance_id}/review", response_model=AttendanceOut)
def review_attendance(attendance_id: uuid.UUID, body: ReviewIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return attendance.review(db, p, attendance_id, body)


@inspections_router.post("", response_model=InspectionOut, status_code=status.HTTP_201_CREATED,
                         responses={200: {"description": "Idempotent replay of an existing record"}})
def create_inspection(body: InspectionIn, response: Response, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    record, replayed = inspections.create(db, p, body)
    _created(response, replayed)
    return record


@inspections_router.get("", response_model=Page[InspectionOut])
def list_inspections(params: PageParams = Depends(), journey_id: uuid.UUID | None = None, coach_code: str | None = None,
                     day: int | None = None, phase: InspectionPhase | None = None,
                     verification_status: VerificationStatus | None = None,
                     db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = inspections.list_records(db, p, params, journey_id=journey_id, coach_code=coach_code, day=day,
                                            phase=phase, verification_status=verification_status)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@inspections_router.get("/journeys/{journey_id}/status", response_model=list[CoachDayStatus])
def inspection_grid(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Coach x day x round x phase grid with taken/open/locked cells and completion counts."""
    return inspections.journey_grid(db, p, journey_id)


@inspections_router.get("/{inspection_id}", response_model=InspectionOut)
def get_inspection(inspection_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return inspections.get(db, p, inspection_id)


@inspections_router.post("/{inspection_id}/review", response_model=InspectionOut)
def review_inspection(inspection_id: uuid.UUID, body: ReviewIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return inspections.review(db, p, inspection_id, body)
