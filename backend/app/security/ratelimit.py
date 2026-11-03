import threading
import time
from collections import defaultdict, deque

from fastapi import Depends, Request

from app.errors import TooManyRequests
from app.security.principal import Principal, get_principal


class SlidingWindowLimiter:
    """In-process limiter. Per-worker only: behind several workers, put an edge limiter in front as well.
    OTP abuse is additionally bounded in the database (attempt and send counters)."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window_seconds:
                q.popleft()
            if len(q) >= limit:
                raise TooManyRequests("Too many requests, slow down", details={"retry_after_seconds": int(window_seconds - (now - q[0])) + 1})
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowLimiter()


def rate_limit(limit: int, window_seconds: int):
    def dependency(request: Request, principal: Principal = Depends(get_principal)) -> Principal:
        limiter.hit(f"{principal.id}:{request.scope['route'].path}", limit, window_seconds)
        return principal

    return dependency
