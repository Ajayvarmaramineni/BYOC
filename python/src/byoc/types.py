"""Provider-neutral types shared by every BYOC adapter.

These mirror the semantics of the TypeScript SDK's types, but not its spelling:
field names are ``snake_case`` because that is what Python callers expect. Only
values that cross into provider storage -- see ``spec/fixtures/provider-metadata.json``
-- keep their original casing.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Literal, Protocol, runtime_checkable

ProviderCategory = Literal["personal-cloud", "self-hosted", "developer-cloud"]
AuthType = Literal["oauth2", "access-key", "basic", "local"]
ObjectType = Literal["file", "folder"]

StorageInput = bytes | bytearray | memoryview | str | AsyncIterator[bytes]
"""Accepted upload payloads. Async iterators of bytes stream without buffering."""


class ConflictStrategy(str, Enum):
    """How a migration resolves a file that already exists on the target."""

    OVERWRITE = "overwrite"
    SKIP = "skip"
    ERROR = "error"

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class StorageObject:
    """A file or folder in any BYOC storage backend."""

    id: str
    path: str
    name: str
    provider: str
    provider_id: str
    type: ObjectType | None = None
    size: int | None = None
    mime_type: str | None = None
    checksum: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class StorageQuota:
    """Storage quota reported by the provider. ``None`` means the provider did not say."""

    used: int
    total: int | None = None
    available: int | None = None


@dataclass(frozen=True, slots=True)
class UploadProgress:
    """Progress event emitted during chunked or resumable uploads."""

    bytes_uploaded: int
    total_bytes: int | None = None
    percentage: float | None = None


ProgressCallback = Callable[[UploadProgress], None]


@dataclass(frozen=True, slots=True)
class UploadOptions:
    """Per-upload configuration."""

    mime_type: str | None = None
    resumable: bool | None = None
    chunk_size: int | None = None
    on_progress: ProgressCallback | None = None
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BackupOptions:
    """Configuration for the high-level backup helper."""

    filename: str | None = None
    folder: str | None = None
    mime_type: str | None = None
    on_progress: ProgressCallback | None = None


@dataclass(frozen=True, slots=True)
class ProviderManifest:
    """Static metadata identifying a provider adapter."""

    id: str
    name: str
    category: ProviderCategory
    authentication: AuthType
    supports_user_owned_storage: bool
    adapter_version: str


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    """What a provider can do, so callers feature-detect instead of guessing."""

    folders: bool = False
    sharing: bool = False
    public_urls: bool = False
    resumable_uploads: bool = False
    versioning: bool = False
    quota: bool = False
    server_side_copy: bool = False


@dataclass(frozen=True, slots=True)
class StorageOutput:
    """A downloaded object: its metadata plus lazy accessors for the payload.

    ``stream`` yields chunks without buffering the whole object; ``read`` and
    ``text`` buffer it. Exactly one of them should be consumed.
    """

    metadata: StorageObject
    stream: Callable[[], AsyncIterator[bytes]]
    read: Callable[[], Awaitable[bytes]]

    async def text(self, encoding: str = "utf-8") -> str:
        """Buffer the payload and decode it."""
        return (await self.read()).decode(encoding)


@runtime_checkable
class BYOCProvider(Protocol):
    """The interface every storage adapter implements.

    Optional operations (``create_folder``, ``move``, ``copy``, ``quota``) are
    declared on the matching :class:`ProviderCapabilities` flag. Callers should
    check the flag rather than probing for the attribute.
    """

    def manifest(self) -> ProviderManifest:
        """Return metadata identifying this provider."""
        ...

    def capabilities(self) -> ProviderCapabilities:
        """Return the feature flags this provider instance supports."""
        ...

    async def connect(self) -> None:
        """Establish or verify the session with the storage backend."""
        ...

    async def disconnect(self) -> None:
        """Tear down the session and clear any cached credentials."""
        ...

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        """Write ``data`` to ``path``."""
        ...

    async def download(self, path: str) -> StorageOutput:
        """Read the object at ``path``."""
        ...

    async def delete(self, path: str) -> None:
        """Remove the object at ``path``."""
        ...

    async def list(self, path: str | None = None) -> list[StorageObject]:
        """List objects directly under ``path``, or under the root if omitted."""
        ...

    async def exists(self, path: str) -> bool:
        """Return whether an object exists at ``path``."""
        ...

    async def metadata(self, path: str) -> StorageObject:
        """Return metadata for the object at ``path``."""
        ...
