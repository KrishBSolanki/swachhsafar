from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO, Protocol

from app.config import get_settings


class StorageBackend(Protocol):
    serves_directly: bool

    def put(self, path: str, data: BinaryIO, content_type: str) -> None: ...

    def signed_url(self, path: str, ttl: timedelta) -> str: ...

    def open(self, path: str) -> BinaryIO: ...


class FirebaseStorage:
    """Firebase Storage (GCS) via the Admin SDK. Clients never write to the bucket directly."""

    serves_directly = False

    def __init__(self) -> None:
        from firebase_admin import storage

        from app.security.tokens import get_token_verifier

        get_token_verifier()  # ensures firebase_admin is initialised with the bucket option
        self._bucket = storage.bucket(get_settings().firebase_storage_bucket)

    def put(self, path: str, data: BinaryIO, content_type: str) -> None:
        blob = self._bucket.blob(path)
        blob.upload_from_file(data, content_type=content_type, rewind=True, if_generation_match=0)

    def signed_url(self, path: str, ttl: timedelta) -> str:
        return self._bucket.blob(path).generate_signed_url(version="v4", expiration=ttl, method="GET")

    def open(self, path: str) -> BinaryIO:
        raise NotImplementedError("Firebase media is served through signed URLs")


class LocalStorage:
    """Filesystem storage for development and tests. Refused in production by Settings validation."""

    serves_directly = True

    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, path: str) -> Path:
        target = (self.root / path).resolve()
        if self.root not in target.parents:
            raise ValueError("path escapes storage root")
        return target

    def put(self, path: str, data: BinaryIO, content_type: str) -> None:
        target = self._resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data.seek(0)
        with open(target, "wb") as fh:
            while chunk := data.read(1024 * 1024):
                fh.write(chunk)

    def signed_url(self, path: str, ttl: timedelta) -> str:
        raise NotImplementedError

    def open(self, path: str) -> BinaryIO:
        return open(self._resolve(path), "rb")


@lru_cache
def get_storage() -> StorageBackend:
    settings = get_settings()
    if settings.storage_backend == "firebase":
        return FirebaseStorage()
    return LocalStorage(settings.local_media_dir)
