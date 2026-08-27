"""Logging that redacts credentials before they reach a handler.

BYOC handles OAuth tokens, refresh tokens and cloud access keys, so anything
that might carry one is scrubbed on the way out. A leaked token in an aggregated
log is a real compromise, not a cosmetic problem.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Protocol

REDACTED = "[REDACTED_SECRET]"

_SENSITIVE_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9_\-.]+", re.IGNORECASE),
    re.compile(r"ya29\.[A-Za-z0-9_\-.]+", re.IGNORECASE),
    re.compile(
        r"(\"?(?:access_token|refresh_token|client_secret|api_key|apikey|secret|"
        r"authorization|password)\"?\s*[:=]\s*\"?[^\",\s}]+\"?)",
        re.IGNORECASE,
    ),
]

_SENSITIVE_KEY_HINTS = ("token", "secret", "password", "authorization", "credential", "api_key")


def sanitize(value: Any) -> Any:
    """Recursively redact secrets from strings, mappings and sequences.

    Mapping keys are matched by name as well as value, because a credential
    stored under an obvious key often would not match the value patterns.
    """
    if isinstance(value, str):
        cleaned = value
        for pattern in _SENSITIVE_PATTERNS:
            cleaned = pattern.sub(REDACTED, cleaned)
        return cleaned

    if isinstance(value, dict):
        result: dict[Any, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and any(h in key.lower() for h in _SENSITIVE_KEY_HINTS):
                result[key] = REDACTED
            else:
                result[key] = sanitize(item)
        return result

    if isinstance(value, list | tuple | set):
        return type(value)(sanitize(item) for item in value)

    if isinstance(value, BaseException):
        return {"type": type(value).__name__, "message": sanitize(str(value))}

    return value


class BYOCLogger(Protocol):
    """Minimal logging surface BYOC depends on."""

    def debug(self, message: str, *args: Any) -> None: ...
    def info(self, message: str, *args: Any) -> None: ...
    def warning(self, message: str, *args: Any) -> None: ...
    def error(self, message: str, *args: Any) -> None: ...


class SafeLogger:
    """Wraps a :mod:`logging` logger and sanitizes every message and argument."""

    def __init__(self, name: str = "byoc", level: int = logging.INFO) -> None:
        self._logger = logging.getLogger(name)
        self._logger.setLevel(level)

    def _emit(self, level: int, message: str, args: tuple[Any, ...]) -> None:
        if self._logger.isEnabledFor(level):
            self._logger.log(level, str(sanitize(message)), *(sanitize(a) for a in args))

    def debug(self, message: str, *args: Any) -> None:
        self._emit(logging.DEBUG, message, args)

    def info(self, message: str, *args: Any) -> None:
        self._emit(logging.INFO, message, args)

    def warning(self, message: str, *args: Any) -> None:
        self._emit(logging.WARNING, message, args)

    def error(self, message: str, *args: Any) -> None:
        self._emit(logging.ERROR, message, args)


class SilentLogger:
    """Discards everything. The default, so importing BYOC never adds log noise."""

    def debug(self, message: str, *args: Any) -> None: ...
    def info(self, message: str, *args: Any) -> None: ...
    def warning(self, message: str, *args: Any) -> None: ...
    def error(self, message: str, *args: Any) -> None: ...
