from functools import lru_cache
from typing import Protocol

from app.config import get_settings
from app.errors import ServiceUnavailable, Unauthenticated

NOT_CONFIGURED = ("Sign-in cannot be checked: the server's Firebase Admin credentials are not configured "
                  "(FIREBASE_CREDENTIALS_FILE).")


class TokenVerifier(Protocol):
    def verify(self, token: str) -> dict: ...


class FirebaseTokenVerifier:
    """Verifies Firebase ID tokens with the Admin SDK, including revocation checks."""

    def __init__(self) -> None:
        import firebase_admin
        from firebase_admin import credentials

        settings = get_settings()
        if not firebase_admin._apps:
            try:
                cred = (
                    credentials.Certificate(settings.firebase_credentials_file)
                    if settings.firebase_credentials_file
                    else credentials.ApplicationDefault()
                )
            except (OSError, ValueError) as exc:  # missing / unreadable / invalid service-account file
                raise ServiceUnavailable(NOT_CONFIGURED, code="auth_not_configured") from exc
            options = {"projectId": settings.firebase_project_id}
            if settings.firebase_storage_bucket:
                options["storageBucket"] = settings.firebase_storage_bucket
            firebase_admin.initialize_app(cred, options)

    def verify(self, token: str) -> dict:
        from firebase_admin import auth

        from google.auth.exceptions import DefaultCredentialsError

        try:
            return auth.verify_id_token(token, check_revoked=True)
        except DefaultCredentialsError as exc:  # no service account and no Application Default Credentials
            raise ServiceUnavailable(NOT_CONFIGURED, code="auth_not_configured") from exc
        except auth.RevokedIdTokenError as exc:
            raise Unauthenticated("Token revoked", code="token_revoked") from exc
        except auth.UserDisabledError as exc:
            raise Unauthenticated("Firebase account disabled", code="account_disabled") from exc
        except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, ValueError) as exc:
            raise Unauthenticated("Invalid or expired token", code="invalid_token") from exc


@lru_cache
def get_token_verifier() -> TokenVerifier:
    return FirebaseTokenVerifier()
