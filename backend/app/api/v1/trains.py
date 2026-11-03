import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import BusinessRuleViolation
from app.schemas.common import Page, PageParams
from app.schemas.trains import CoachesReplace, CoachOut, TrainCreate, TrainOut, TrainUpdate
from app.security.principal import Principal, get_principal
from app.services import journeys as journey_svc
from app.services import trains as svc

router = APIRouter(prefix="/trains", tags=["trains"])
coaches_router = APIRouter(prefix="/coaches", tags=["coaches"])


@router.get("", response_model=Page[TrainOut])
def list_trains(params: PageParams = Depends(), division_id: uuid.UUID | None = None, active: bool | None = None,
                q: str | None = Query(None, max_length=50), db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.list_trains(db, p, params, division_id=division_id, active=active, q=q)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("", response_model=TrainOut, status_code=status.HTTP_201_CREATED)
def create_train(body: TrainCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_train(db, p, body)


@router.get("/{train_id}", response_model=TrainOut)
def get_train(train_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.get_train(db, p, train_id)


@router.patch("/{train_id}", response_model=TrainOut)
def update_train(train_id: uuid.UUID, body: TrainUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update_train(db, p, train_id, body)


@router.put("/{train_id}/coaches", response_model=TrainOut)
def replace_coaches(train_id: uuid.UUID, body: CoachesReplace, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.replace_coaches(db, p, train_id, body)


@coaches_router.get("", response_model=list[CoachOut])
def list_coaches(train_id: uuid.UUID | None = None, journey_id: uuid.UUID | None = None,
                 db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Coaches with AC/Non-AC classification for a train (master) or a journey (snapshot)."""
    if journey_id is not None:
        return journey_svc.get_journey(db, p, journey_id).coaches
    if train_id is not None:
        return svc.get_train(db, p, train_id).coaches
    raise BusinessRuleViolation("Pass train_id or journey_id")
