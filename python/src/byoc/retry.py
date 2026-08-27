"""Retry with exponential backoff for transient provider failures."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

from .errors import StorageError

T = TypeVar("T")

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BASE_DELAY_SECONDS = 0.25
DEFAULT_MAX_DELAY_SECONDS = 8.0


def backoff_delay(
    attempt: int,
    base_delay: float = DEFAULT_BASE_DELAY_SECONDS,
    max_delay: float = DEFAULT_MAX_DELAY_SECONDS,
) -> float:
    """Return the delay before ``attempt`` (1-based), with full jitter.

    Jitter matters when many uploads are rate-limited at once: without it they
    all retry on the same schedule and re-trigger the limit together.
    """
    capped = min(max_delay, base_delay * (2 ** (attempt - 1)))
    # Jitter only; not security-sensitive randomness.
    return random.uniform(0, capped)


async def with_retry(
    operation: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY_SECONDS,
    max_delay: float = DEFAULT_MAX_DELAY_SECONDS,
) -> T:
    """Run ``operation``, retrying only errors the provider marked retryable.

    A non-retryable failure (bad credentials, missing object) is raised
    immediately rather than burning attempts on something that cannot succeed.
    """
    last_error: BaseException | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except StorageError as exc:
            if not exc.retryable or attempt == max_attempts:
                raise
            last_error = exc
            await asyncio.sleep(backoff_delay(attempt, base_delay, max_delay))

    # Unreachable: the loop either returns or raises.
    raise last_error if last_error else RuntimeError("with_retry exhausted without an error")
