from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def today_ist(now: datetime | None = None) -> date:
    return (now or utcnow()).astimezone(IST).date()


def to_ist_date(ts: datetime) -> date:
    if ts.tzinfo is None:
        raise ValueError("timestamp must be timezone-aware")
    return ts.astimezone(IST).date()
