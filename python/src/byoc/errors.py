"""Provider-neutral error taxonomy.

The ``code`` strings are the cross-SDK contract and match the TypeScript
``BYOCErrorCode`` exactly -- conformance fixtures assert on them. The exception
*classes* are Python's own concern: callers should catch types, not compare
strings.
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class BYOCErrorCode(str, Enum):
    """Shared error codes. These strings are wire contract; do not rename.

    Subclasses ``str`` rather than using ``enum.StrEnum`` so the package still
    supports Python 3.10.
    """

    def __str__(self) -> str:
        return self.value

    AUTH_REQUIRED = "BYOC_AUTH_REQUIRED"
    OBJECT_NOT_FOUND = "BYOC_OBJECT_NOT_FOUND"
    PERMISSION_DENIED = "BYOC_PERMISSION_DENIED"
    QUOTA_EXCEEDED = "BYOC_QUOTA_EXCEEDED"
    RATE_LIMITED = "BYOC_RATE_LIMITED"
    UPLOAD_FAILED = "BYOC_UPLOAD_FAILED"
    DOWNLOAD_FAILED = "BYOC_DOWNLOAD_FAILED"
    PROVIDER_UNAVAILABLE = "BYOC_PROVIDER_UNAVAILABLE"
    # Public wire error code, not a credential.
    TOKEN_EXPIRED = "BYOC_TOKEN_EXPIRED"  # nosec B105
    CONFLICT = "BYOC_CONFLICT"
    OBJECT_ALREADY_EXISTS = "BYOC_OBJECT_ALREADY_EXISTS"
    CAPABILITY_UNSUPPORTED = "BYOC_CAPABILITY_UNSUPPORTED"
    INVALID_INPUT = "BYOC_INVALID_INPUT"
    CORRUPTED_DATA = "BYOC_CORRUPTED_DATA"


class StorageError(Exception):
    """Base class for every BYOC error.

    Catch this to handle any storage failure; catch a subclass to handle one
    kind. ``code`` is the shared identifier used by the conformance fixtures.
    """

    code: BYOCErrorCode = BYOCErrorCode.PROVIDER_UNAVAILABLE

    def __init__(
        self,
        message: str,
        *,
        provider: str = "core",
        status_code: int | None = None,
        retryable: bool = False,
        raw_error: Any = None,
        code: BYOCErrorCode | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.provider = provider
        self.status_code = status_code
        self.retryable = retryable
        self.raw_error = raw_error
        if code is not None:
            self.code = code

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(code={self.code!r}, provider={self.provider!r}, "
            f"message={self.message!r})"
        )


class AuthRequiredError(StorageError):
    """Authentication is missing, invalid, or expired. Re-auth required."""

    code = BYOCErrorCode.AUTH_REQUIRED


class ObjectNotFoundError(StorageError):
    """The requested object or folder path was not found."""

    code = BYOCErrorCode.OBJECT_NOT_FOUND


class PermissionDeniedError(StorageError):
    """Permission denied by the provider (read-only access or insufficient scope)."""

    code = BYOCErrorCode.PERMISSION_DENIED


class QuotaExceededError(StorageError):
    """The target cloud account has exceeded its storage quota."""

    code = BYOCErrorCode.QUOTA_EXCEEDED


class RateLimitedError(StorageError):
    """Provider rate limit exceeded. Temporary and retryable."""

    code = BYOCErrorCode.RATE_LIMITED

    def __init__(self, message: str, **kwargs: Any) -> None:
        kwargs.setdefault("retryable", True)
        super().__init__(message, **kwargs)


class UploadFailedError(StorageError):
    """Upload failed during binary transmission or chunk assembly."""

    code = BYOCErrorCode.UPLOAD_FAILED


class DownloadFailedError(StorageError):
    """Download failed or the connection was severed during streaming."""

    code = BYOCErrorCode.DOWNLOAD_FAILED


class ProviderUnavailableError(StorageError):
    """Provider service is down or temporarily unreachable."""

    code = BYOCErrorCode.PROVIDER_UNAVAILABLE


class TokenExpiredError(StorageError):
    """Authentication token expired and refresh failed."""

    code = BYOCErrorCode.TOKEN_EXPIRED


class ConflictError(StorageError):
    """Conflict detected, such as a naming clash or concurrent modification."""

    code = BYOCErrorCode.CONFLICT


class ObjectAlreadyExistsError(StorageError):
    """The target object already exists on the destination provider."""

    code = BYOCErrorCode.OBJECT_ALREADY_EXISTS


class CapabilityUnsupportedError(StorageError):
    """The connected provider does not support the requested operation."""

    code = BYOCErrorCode.CAPABILITY_UNSUPPORTED


class InvalidInputError(StorageError):
    """Input validation failed, such as an invalid virtual path."""

    code = BYOCErrorCode.INVALID_INPUT


class CorruptedDataError(StorageError):
    """Ciphertext payload or metadata is corrupted or malformed."""

    code = BYOCErrorCode.CORRUPTED_DATA


ERROR_CLASS_BY_CODE: dict[BYOCErrorCode, type[StorageError]] = {
    BYOCErrorCode.AUTH_REQUIRED: AuthRequiredError,
    BYOCErrorCode.OBJECT_NOT_FOUND: ObjectNotFoundError,
    BYOCErrorCode.PERMISSION_DENIED: PermissionDeniedError,
    BYOCErrorCode.QUOTA_EXCEEDED: QuotaExceededError,
    BYOCErrorCode.RATE_LIMITED: RateLimitedError,
    BYOCErrorCode.UPLOAD_FAILED: UploadFailedError,
    BYOCErrorCode.DOWNLOAD_FAILED: DownloadFailedError,
    BYOCErrorCode.PROVIDER_UNAVAILABLE: ProviderUnavailableError,
    BYOCErrorCode.TOKEN_EXPIRED: TokenExpiredError,
    BYOCErrorCode.CONFLICT: ConflictError,
    BYOCErrorCode.OBJECT_ALREADY_EXISTS: ObjectAlreadyExistsError,
    BYOCErrorCode.CAPABILITY_UNSUPPORTED: CapabilityUnsupportedError,
    BYOCErrorCode.INVALID_INPUT: InvalidInputError,
    BYOCErrorCode.CORRUPTED_DATA: CorruptedDataError,
}
"""Maps a shared error code to its Python exception class.

Used by the conformance suite, which asserts on codes, and by provider adapters
mapping a remote error response onto the right exception type.
"""
