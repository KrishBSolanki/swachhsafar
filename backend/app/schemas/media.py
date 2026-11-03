import uuid
from datetime import datetime

from pydantic import Field

from app.models import MediaKind, MediaStatus
from app.schemas.common import ReadModel, StrictModel


class MediaInit(StrictModel):
    id: uuid.UUID = Field(description="Device-generated id; re-sending the same init is idempotent")
    division_id: uuid.UUID
    kind: MediaKind
    content_type: str = Field(max_length=100)
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class MediaOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    kind: MediaKind
    status: MediaStatus
    content_type: str | None
    size_bytes: int | None
    sha256: str
    rejection_reason: str | None
    uploaded_at: datetime | None
    upload_url: str


class MediaLink(StrictModel):
    url: str
    expires_at: datetime | None
