import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import NotFound
from app.models import MediaObject
from app.providers.storage import StorageBackend, get_storage
from app.schemas.media import MediaInit, MediaLink, MediaOut
from app.security.principal import Principal, get_principal
from app.services import media as svc

router = APIRouter(prefix="/media", tags=["media"])


@router.post("", response_model=MediaOut, status_code=status.HTTP_201_CREATED)
def init_upload(body: MediaInit, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Register a file before sending its bytes. Records may only reference media once its status is `uploaded`."""
    return svc.init_upload(db, p, body)


@router.put("/{media_id}/content", response_model=MediaOut)
async def upload_content(media_id: uuid.UUID, request: Request, db: Session = Depends(get_db),
                         p: Principal = Depends(get_principal), storage: StorageBackend = Depends(get_storage)):
    """Raw request body = file bytes. Size, SHA-256 and sniffed content type are verified server-side."""
    return await svc.receive_content(db, p, storage, media_id, request.stream())


@router.get("/{media_id}", response_model=MediaOut)
def get_media(media_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    media = db.get(MediaObject, media_id)
    if media is None or (media.owner_id != p.id and not p.has(svc.RULES[media.kind].read_permission, media.division_id)):
        raise NotFound("Media not found")
    return media


@router.get("/{media_id}/download", response_model=MediaLink)
def download(media_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal),
             storage: StorageBackend = Depends(get_storage)):
    media = svc.authorize_read(db, p, media_id)
    url, expires = svc.download_link(storage, media)
    return MediaLink(url=url, expires_at=expires)


@router.get("/{media_id}/file", include_in_schema=False)
def serve_local(media_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal),
                storage: StorageBackend = Depends(get_storage)):
    if not storage.serves_directly:
        raise NotFound("Not available")
    media = svc.authorize_read(db, p, media_id)
    fh = storage.open(media.storage_path)
    return StreamingResponse(fh, media_type=media.content_type,
                             headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
