import uuid

from sqlalchemy.orm import Session

from app.models import DivisionPolicy
from app.schemas.policy import PolicySettings
from app.services.common import audit


def get_policy(db: Session, division_id: uuid.UUID) -> PolicySettings:
    row = db.get(DivisionPolicy, division_id)
    return PolicySettings.model_validate(row.settings if row else {})


def set_policy(db: Session, division_id: uuid.UUID, settings: PolicySettings, actor_id: uuid.UUID) -> PolicySettings:
    row = db.get(DivisionPolicy, division_id)
    before = PolicySettings.model_validate(row.settings if row else {})
    new = settings.model_dump()
    if row is None:
        row = DivisionPolicy(division_id=division_id, settings=new, updated_by_id=actor_id)
        db.add(row)
    else:
        row.settings = new
        row.updated_by_id = actor_id
    changes = {k: {"from": v, "to": new[k]} for k, v in before.model_dump().items() if v != new[k]}
    audit(db, actor_id=actor_id, action="policy.update", entity=row, division_id=division_id, changes=changes)
    db.commit()
    return settings
