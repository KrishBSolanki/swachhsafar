from functools import lru_cache
from typing import Protocol

from app.config import get_settings
from app.errors import Unauthenticated


class TokenVerifier(Protocol):
    def verify(self, token: str) -> dict: ...


class FirebaseTokenVerifier:
    """Verifies Firebase ID tokens with the Admin SDK, including revocation checks."""

    def __init__(self) -> None:
        import firebase_admin
        from firebase_admin import credentials

        settings = get_settings()
        if not firebase_admin._apps:
            cred = (
                credentials.Certificate(settings.firebase_credentials_file)
                if settings.firebase_credentials_file
                else credentials.ApplicationDefault()
            )
            options = {"projectId": settings.firebase_project_id}
            if settings.firebase_storage_bucket:
                options["storageBucket"] = settings.firebase_storage_bucket
            firebase_admin.initialize_app(cred, options)

    def verify(self, token: str) -> dict:
        from firebase_admin import auth

        try:
            return auth.verify_id_token(token, check_revoked=True)
        except auth.RevokedIdTokenError as exc:
            raise Unauthenticated("Token revoked", code="token_revoked") from exc
        except auth.UserDisabledError as exc:
            raise Unauthenticated("Firebase account disabled", code="account_disabled") from exc
        except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, ValueError) as exc:
            raise Unauthenticated("Invalid or expired token", code="invalid_token") from exc


@lru_cache
def get_token_verifier() -> TokenVerifier:
    return FirebaseTokenVerifier()
