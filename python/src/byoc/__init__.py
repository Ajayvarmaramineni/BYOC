"""BYOC (Bring Your Own Cloud) — universal storage abstraction for Python.

Peer implementation of the TypeScript ``@byoc/core`` SDK. Both run against the
shared conformance vectors in ``spec/fixtures``, so files written by one are
readable by the other -- including client-side encrypted files.
"""

from __future__ import annotations

from .client import AsyncBYOC, lookup_mime_type
from .encryption import (
    E2EE_MAGIC_HEADER_V3,
    E2EE_V3_DEFAULT_FRAME_SIZE,
    E2EE_V3_HEADER_LENGTH,
    E2EE_V3_MAX_FRAME_SIZE,
    E2EE_V3_MIN_FRAME_SIZE,
    E2EECrypto,
)
from .errors import (
    AuthRequiredError,
    BYOCErrorCode,
    CapabilityUnsupportedError,
    ConflictError,
    CorruptedDataError,
    DownloadFailedError,
    InvalidInputError,
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    PermissionDeniedError,
    ProviderUnavailableError,
    QuotaExceededError,
    RateLimitedError,
    StorageError,
    TokenExpiredError,
    UploadFailedError,
)
from .logging import BYOCLogger, SafeLogger, SilentLogger, sanitize
from .migration import (
    MigrationFileResult,
    MigrationProgress,
    MigrationReport,
    migrate,
)
from .paths import (
    encode_path_segments,
    get_basename,
    get_dirname,
    normalize_virtual_path,
    rfc3986_uri_encode,
    split_path,
)
from .providers.gdrive import (
    GoogleDriveProvider,
    GoogleDriveScope,
)
from .providers.local import LocalFileSystemProvider
from .providers.memory import MemoryProvider
from .retry import with_retry
from .types import (
    AuthType,
    BackupOptions,
    BYOCProvider,
    ConflictStrategy,
    ObjectType,
    ProviderCapabilities,
    ProviderCategory,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadGrant,
    UploadGrantOptions,
    UploadOptions,
    UploadProgress,
)

__version__ = "0.4.0"

__all__ = [
    "E2EE_MAGIC_HEADER_V3",
    "E2EE_V3_DEFAULT_FRAME_SIZE",
    "E2EE_V3_HEADER_LENGTH",
    "E2EE_V3_MAX_FRAME_SIZE",
    "E2EE_V3_MIN_FRAME_SIZE",
    "AsyncBYOC",
    "AuthRequiredError",
    "AuthType",
    "BYOCErrorCode",
    "BYOCLogger",
    "BYOCProvider",
    "BackupOptions",
    "CapabilityUnsupportedError",
    "ConflictError",
    "ConflictStrategy",
    "CorruptedDataError",
    "DownloadFailedError",
    "E2EECrypto",
    "GoogleDriveProvider",
    "GoogleDriveScope",
    "InvalidInputError",
    "LocalFileSystemProvider",
    "MemoryProvider",
    "MigrationFileResult",
    "MigrationProgress",
    "MigrationReport",
    "ObjectAlreadyExistsError",
    "ObjectNotFoundError",
    "ObjectType",
    "PermissionDeniedError",
    "ProviderCapabilities",
    "ProviderCategory",
    "ProviderManifest",
    "ProviderUnavailableError",
    "QuotaExceededError",
    "RateLimitedError",
    "SafeLogger",
    "SilentLogger",
    "StorageError",
    "StorageInput",
    "StorageObject",
    "StorageOutput",
    "StorageQuota",
    "TokenExpiredError",
    "UploadFailedError",
    "UploadGrant",
    "UploadGrantOptions",
    "UploadOptions",
    "UploadProgress",
    "__version__",
    "encode_path_segments",
    "get_basename",
    "get_dirname",
    "lookup_mime_type",
    "migrate",
    "normalize_virtual_path",
    "rfc3986_uri_encode",
    "sanitize",
    "split_path",
    "with_retry",
]
