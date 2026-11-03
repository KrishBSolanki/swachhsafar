"""External PNR and SMS providers. Credentials come only from environment configuration."""

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Protocol

import httpx

from app.config import get_settings


class ProviderUnavailable(Exception):
    """The provider could not give an answer (disabled, network, 5xx). The record stays pending."""


@dataclass(frozen=True)
class PnrResult:
    found: bool
    train_number: str | None = None
    train_name: str | None = None
    coach_ids: frozenset[str] = field(default_factory=frozenset)
    status_text: str | None = None


class PnrProvider(Protocol):
    def lookup(self, pnr: str) -> PnrResult: ...


class SmsProvider(Protocol):
    def send_otp(self, mobile: str, code: str) -> None: ...


class DisabledPnrProvider:
    def lookup(self, pnr: str) -> PnrResult:
        raise ProviderUnavailable("PNR verification is not configured")


class DisabledSmsProvider:
    def send_otp(self, mobile: str, code: str) -> None:
        raise ProviderUnavailable("SMS delivery is not configured")


class RapidApiPnrProvider:
    """IRCTC PNR status via RapidAPI (response: data.trainNumber, data.passengerList[].*CoachId)."""

    def __init__(self, url: str, host: str, key: str, timeout: float) -> None:
        self._url, self._host, self._key, self._timeout = url.rstrip("/") + "/", host, key, timeout

    def lookup(self, pnr: str) -> PnrResult:
        try:
            resp = httpx.get(self._url + pnr, timeout=self._timeout,
                             headers={"x-rapidapi-key": self._key, "x-rapidapi-host": self._host})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"PNR provider unreachable: {type(exc).__name__}") from exc
        if resp.status_code >= 500 or resp.status_code == 429:
            raise ProviderUnavailable(f"PNR provider returned {resp.status_code}")
        if resp.status_code >= 400:
            return PnrResult(found=False)
        try:
            data = (resp.json() or {}).get("data") or {}
        except ValueError as exc:
            raise ProviderUnavailable("PNR provider returned invalid JSON") from exc
        passengers = data.get("passengerList") or []
        if not data.get("numberOfpassenger") or not passengers:
            return PnrResult(found=False)
        coaches = set()
        for pax in passengers:
            for key in ("bookingCoachId", "currentCoachId"):
                if pax.get(key):
                    coaches.add(str(pax[key]).strip().upper())
        first = passengers[0]
        return PnrResult(found=True, train_number=str(data.get("trainNumber") or "").strip() or None,
                         train_name=data.get("trainName"), coach_ids=frozenset(coaches),
                         status_text=first.get("currentStatusDetails") or first.get("currentStatus"))


class HttpSmsProvider:
    """Generic JSON-over-HTTPS SMS gateway adapter: POST {to, message, sender, template_id} with a bearer key.
    Adapt the payload to the contracted DLT-registered gateway before production use."""

    def __init__(self, url: str, key: str, sender: str | None, template_id: str | None, timeout: float) -> None:
        self._url, self._key, self._sender, self._template, self._timeout = url, key, sender, template_id, timeout

    def send_otp(self, mobile: str, code: str) -> None:
        payload = {"to": f"91{mobile}", "message": f"{code} is your Swachh Safar feedback verification code.",
                   "sender": self._sender, "template_id": self._template}
        try:
            resp = httpx.post(self._url, json=payload, timeout=self._timeout, headers={"Authorization": f"Bearer {self._key}"})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"SMS gateway unreachable: {type(exc).__name__}") from exc
        if resp.status_code >= 300:
            raise ProviderUnavailable(f"SMS gateway returned {resp.status_code}")


@lru_cache
def get_pnr_provider() -> PnrProvider:
    s = get_settings()
    if s.pnr_provider == "rapidapi":
        if not (s.pnr_api_url and s.pnr_api_host and s.pnr_api_key):
            raise RuntimeError("PNR_PROVIDER=rapidapi requires PNR_API_URL, PNR_API_HOST and PNR_API_KEY")
        return RapidApiPnrProvider(s.pnr_api_url, s.pnr_api_host, s.pnr_api_key.get_secret_value(), s.external_timeout_seconds)
    return DisabledPnrProvider()


@lru_cache
def get_sms_provider() -> SmsProvider:
    s = get_settings()
    if s.sms_provider == "http":
        if not (s.sms_api_url and s.sms_api_key):
            raise RuntimeError("SMS_PROVIDER=http requires SMS_API_URL and SMS_API_KEY")
        return HttpSmsProvider(s.sms_api_url, s.sms_api_key.get_secret_value(), s.sms_sender_id, s.sms_template_id,
                               s.external_timeout_seconds)
    return DisabledSmsProvider()
