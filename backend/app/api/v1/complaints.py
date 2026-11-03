import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import ComplaintStatus
from app.schemas.common import Page, PageParams
from app.schemas.complaints import (
    CategoryIn,
    CategoryOut,
    CategoryUpdate,
    ComplaintIn,
    ComplaintOut,
    DepartmentIn,
    DepartmentOut,
    DepartmentUpdate,
    TransitionIn,
)
from app.security.principal import Principal, get_principal
from app.services import complaints as svc

router = APIRouter(prefix="/complaints", tags=["complaints"])


@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_departments(db, p, division_id)


@router.post("/departments", response_model=DepartmentOut, status_code=status.HTTP_201_CREATED)
def create_department(body: DepartmentIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_department(db, p, body)


@router.patch("/departments/{dep_id}", response_model=DepartmentOut)
def update_department(dep_id: uuid.UUID, body: DepartmentUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update_department(db, p, dep_id, body)


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_categories(db, p, division_id)


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(body: CategoryIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_category(db, p, body)


@router.patch("/categories/{cat_id}", response_model=CategoryOut)
def update_category(cat_id: uuid.UUID, body: CategoryUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update_category(db, p, cat_id, body)


@router.post("", response_model=ComplaintOut, status_code=status.HTTP_201_CREATED)
def create_complaint(body: ComplaintIn, response: Response, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    c, replayed = svc.create(db, p, body)
    if replayed:
        response.status_code = status.HTTP_200_OK
    return svc.get(db, p, c.id)


@router.get("", response_model=Page[ComplaintOut])
def list_complaints(params: PageParams = Depends(), status_: ComplaintStatus | None = Query(None, alias="status"),
                    overdue: bool | None = None, journey_id: uuid.UUID | None = None, category_id: uuid.UUID | None = None,
                    assigned_to_me: bool = False, division_id: uuid.UUID | None = None,
                    db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.list_records(db, p, params, status=status_, overdue=overdue, journey_id=journey_id,
                                    category_id=category_id, assigned_to_me=assigned_to_me, division_id=division_id)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/{complaint_id}", response_model=ComplaintOut)
def get_complaint(complaint_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.get(db, p, complaint_id)


@router.post("/{complaint_id}/transition", response_model=ComplaintOut)
def transition(complaint_id: uuid.UUID, body: TransitionIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """created -> in_process | forwarded | completed; in_process -> forwarded | completed;
    forwarded -> in_process | forwarded | completed. Completed is final and needs resolution remarks."""
    return svc.transition(db, p, complaint_id, body)
