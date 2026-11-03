import hashlib
import tempfile
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta

import filetype
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import MediaKind, MediaObject, MediaStatus
from app.providers.storage import StorageBackend
from app.schemas.media import MediaInit
from app.security.principal import Principal
from app.services.common import audit
from app.timeutil import utcnow

MB = 1024 * 1024
_IMAGES = {"image/jpeg", "image/png", "image/webp"}


@dataclass(frozen=True)
class MediaRule:
    types: frozenset[str]
    max_bytes: int
    read_permission: str


RULES: dict[MediaKind, MediaRule] = {
    MediaKind.ATTENDANCE_PHOTO: MediaRule(frozenset(_IMAGES), 8 * MB, "attendance.read"),
    MediaKind.INSPECTION_PHOTO: MediaRule(frozenset(_IMAGES), 8 * MB, "inspections.read"),
    MediaKind.INSPECTION_VIDEO: MediaRule(frozenset({"video/mp4", "video/3gpp", "video/webm", "video/quicktime"}), 100 * MB, "inspections.read"),
    MediaKind.FEEDBACK_VOICE: MediaRule(
        frozenset({"audio/mpeg", "audio/mp4", "audio/m4a", "audio/aac", "audio/ogg", "audio/x-wav", "audio/wav", "video/webm", "video/mp4"}),
        10 * MB, "feedback.read"),
    MediaKind.COMPLAINT_ATTACHMENT: MediaRule(frozenset(_IMAGES | {"application/pdf"}), 15 * MB, "complaints.read"),
    MediaKind.KYC_DOCUMENT: MediaRule(frozenset(_IMAGES | {"application/pdf"}), 10 * MB, "users.kyc.read"),
}


def _family(mime: str) -> str:
    return "audio" if mime in {"video/webm", "video/mp4"} else mime.split("/")[0]


def init_upload(db: Session, p: Principal, body: MediaInit) -> MediaObject:
    p.require("media.upload", body.division_id)
    rule = RULES[body.kind]
    if body.size_bytes > rule.max_bytes:
        raise BusinessRuleViolation(f"File exceeds {rule.max_bytes // MB} MB limit for {body.kind.value}", code="file_too_large")
    if body.content_type not in rule.types:
        raise BusinessRuleViolation(f"Content type {body.content_type} not allowed for {body.kind.value}", code="file_type_rejected")
    existing = db.get(MediaObject, body.id)
    if existing is not None:
        if (existing.owner_id, existing.sha256, existing.kind, existing.division_id) != (p.id, body.sha256, body.kind, body.division_id):
            raise Conflict("Media id already used for a different file", code="idempotency_mismatch")
        return existing
    media = MediaObject(id=body.id, division_id=body.division_id, owner_id=p.id, kind=body.kind,
                        declared_content_type=body.content_type, declared_size_bytes=body.size_bytes, sha256=body.sha256)
    db.add(media)
    db.commit()
    return media


async def receive_content(db: Session, p: Principal, storage: StorageBackend, media_id: uuid.UUID,
                          chunks: AsyncIterator[bytes]) -> MediaObject:
    media = db.get(MediaObject, media_id)
    if media is None or media.owner_id != p.id:
        raise NotFound("Media not found")
    if media.status == MediaStatus.UPLOADED:
        return media  # idempotent retry after a lost acknowledgement
    rule = RULES[media.kind]
    limit = min(rule.max_bytes, media.declared_size_bytes)
    digest = hashlib.sha256()
    size = 0
    with tempfile.SpooledTemporaryFile(max_size=4 * MB) as buf:
        async for chunk in chunks:
            size += len(chunk)
            if size > limit:
                return _reject(db, media, "File larger than declared size or kind limit")
            digest.update(chunk)
            buf.write(chunk)
        if size != media.declared_size_bytes:
            return _reject(db, media, "Size does not match declared size")
        if digest.hexdigest() != media.sha256:
            return _reject(db, media, "Checksum mismatch")
        buf.seek(0)
        kind = filetype.guess(buf.read(8192))
        detected = kind.mime if kind else None
        if detected not in rule.types or _family(detected) != _family(media.declared_content_type):
            return _reject(db, media, f"File content is not an allowed type (detected {detected or 'unknown'})")
        now = utcnow()
        path = f"{media.division_id}/{media.kind.value}/{now:%Y/%m}/{media.id}.{kind.extension}"
        storage.put(path, buf, detected)
    media.storage_path = path
    media.content_type = detected
    media.size_bytes = size
    media.status = MediaStatus.UPLOADED
    media.rejection_reason = None
    media.uploaded_at = now
    db.commit()
    return media


def _reject(db: Session, media: MediaObject, reason: str) -> MediaObject:
    # A rejected upload may be retried with corrected bytes for the same id.
    media.status = MediaStatus.REJECTED
    media.rejection_reason = reason
    db.commit()
    raise BusinessRuleViolation(reason, code="media_rejected")


def claim(db: Session, media_id: uuid.UUID | None, kind: MediaKind, division_id: uuid.UUID, uploader_id: uuid.UUID,
          *, required: bool, label: str) -> uuid.UUID | None:
    """Validate that a record may reference this media. Upload must be complete before acknowledgement."""
    if media_id is None:
        if required:
            raise BusinessRuleViolation(f"{label} is required", code="media_required")
        return None
    media = db.get(MediaObject, media_id)
    if media is None or media.owner_id != uploader_id:
        raise BusinessRuleViolation(f"{label} not found", code="media_not_found")
    if media.kind != kind or media.division_id != division_id:
        raise BusinessRuleViolation(f"{label} has the wrong kind or division", code="media_mismatch")
    if media.status != MediaStatus.UPLOADED:
        raise Conflict(f"{label} upload is not complete", code="media_pending")
    return media.id


def authorize_read(db: Session, p: Principal, media_id: uuid.UUID) -> MediaObject:
    media = db.get(MediaObject, media_id)
    if media is None or media.status != MediaStatus.UPLOADED:
        raise NotFound("Media not found")
    if media.owner_id != p.id and not p.has(RULES[media.kind].read_permission, media.division_id):
        raise Forbidden("Not allowed to access this media", code="permission_denied")
    if media.kind == MediaKind.KYC_DOCUMENT:
        audit(db, actor_id=p.id, action="media.kyc.read", entity=media, division_id=media.division_id)
        db.commit()
    return media


def download_link(storage: StorageBackend, media: MediaObject) -> tuple[str, object]:
    if storage.serves_directly:
        return f"/api/v1/media/{media.id}/file", None
    ttl = timedelta(seconds=get_settings().media_url_ttl_seconds)
    return storage.signed_url(media.storage_path, ttl), utcnow() + ttl
