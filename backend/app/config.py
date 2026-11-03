from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str

    firebase_project_id: str | None = None
    firebase_credentials_file: str | None = None
    firebase_storage_bucket: str | None = None

    storage_backend: Literal["firebase", "local"] = "local"
    local_media_dir: str = "./var/media"

    otp_pepper: SecretStr
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 60
    otp_max_sends: int = 3

    cors_origins: list[str] = []

    sms_provider: Literal["disabled", "http"] = "disabled"
    sms_api_url: str | None = None
    sms_api_key: SecretStr | None = None
    sms_sender_id: str | None = None
    sms_template_id: str | None = None

    pnr_provider: Literal["disabled", "rapidapi"] = "disabled"
    pnr_api_url: str | None = None
    pnr_api_host: str | None = None
    pnr_api_key: SecretStr | None = None

    external_timeout_seconds: float = 15.0
    media_url_ttl_seconds: int = 600

    @field_validator("otp_pepper")
    @classmethod
    def _pepper_strength(cls, v: SecretStr) -> SecretStr:
        raw = v.get_secret_value()
        if len(raw) < 32 or raw == "CHANGE_ME":
            raise ValueError("OTP_PEPPER must be a random secret of at least 32 characters")
        return v

    @field_validator("storage_backend")
    @classmethod
    def _no_local_storage_in_prod(cls, v, info):
        if v == "local" and info.data.get("environment") == "production":
            raise ValueError("STORAGE_BACKEND=local is not allowed in production")
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
