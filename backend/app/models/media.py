import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import BigInteger, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk, str_enum


class MediaKind(StrEnum):
    ATTENDANCE_PHOTO = "attendance_photo"
    INSPECTION_PHOTO = "inspection_photo"
    INSPECTION_VIDEO = "inspection_video"
    FEEDBACK_VOICE = "feedback_voice"
    COMPLAINT_ATTACHMENT = "complaint_attachment"
    KYC_DOCUMENT = "kyc_document"


class MediaStatus(StrEnum):
    PENDING = "pending"
    UPLOADED = "uploaded"
    REJECTED = "rejected"


class MediaObject(UUIDPk, Timestamps, Base):
    """Metadata for a file held in object storage. The id is device-generated so uploads are idempotent."""

    __tablename__ = "media_objects"

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    kind: Mapped[MediaKind] = mapped_column(str_enum(MediaKind, 24), nullable=False)
    declared_content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(100))
    declared_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str | None] = mapped_column(String(300), unique=True)
    status: Mapped[MediaStatus] = mapped_column(str_enum(MediaStatus, 10), nullable=False, default=MediaStatus.PENDING)
    rejection_reason: Mapped[str | None] = mapped_column(String(200))
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def upload_url(self) -> str:
        return f"/api/v1/media/{self.id}/content"
