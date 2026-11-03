import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.common import Page, PageParams
from app.schemas.inventory import BalanceRow, ItemIn, ItemOut, ItemUpdate, TxnIn, TxnOut
from app.security.principal import Principal, get_principal
from app.services import inventory as svc

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("/items", response_model=list[ItemOut])
def list_items(division_id: uuid.UUID, active: bool | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_items(db, p, division_id, active)


@router.post("/items", response_model=ItemOut, status_code=status.HTTP_201_CREATED)
def create_item(body: ItemIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_item(db, p, body)


@router.patch("/items/{item_id}", response_model=ItemOut)
def update_item(item_id: uuid.UUID, body: ItemUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update_item(db, p, item_id, body)


@router.post("/transactions", response_model=TxnOut, status_code=status.HTTP_201_CREATED)
def record(body: TxnIn, response: Response, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Append-only issue/return ledger. Corrections are new transactions, never edits."""
    txn, replayed = svc.record(db, p, body)
    if replayed:
        response.status_code = status.HTTP_200_OK
    return txn


@router.get("/journeys/{journey_id}/transactions", response_model=Page[TxnOut])
def ledger(journey_id: uuid.UUID, params: PageParams = Depends(), db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.ledger(db, p, params, journey_id)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/journeys/{journey_id}/balance", response_model=list[BalanceRow])
def balance(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.balance(db, p, journey_id)
