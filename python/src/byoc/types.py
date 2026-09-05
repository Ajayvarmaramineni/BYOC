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
    content_length: int | None = None


@dataclass(frozen=True, slots=True)
class BackupOptions:
    """Configuration for the high-level backup helper."""

    filename: str | None = None
    folder: str | None = None
    mime_type: str | None = None
    on_progress: ProgressCallback | None = None


@dataclass(frozen=True, slots=True)
class BatchFailure:
    """One path a batch operation could not complete, and why."""

    path: str
    error: str
    code: str


@dataclass(frozen=True, slots=True)
class BatchDeleteReport:
    """Outcome of a multi-path delete.

    A batch is reported rather than raising on the first failure, because a
    partial delete is the common real case: one object is locked or already
    gone while the rest succeed, and the caller needs to know which.
    """

    deleted: list[str] = field(default_factory=list)
    failed: list[BatchFailure] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.deleted) + len(self.failed)

    @property
    def all_succeeded(self) -> bool:
        return not self.failed


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
    direct_upload: bool = False
    """Whether the provider can mint an :class:`UploadGrant`, letting a browser
    upload straight to the user's cloud without bytes crossing this server."""


@dataclass(frozen=True, slots=True)
class UploadGrant:
    """A capability to upload one object, safe to hand to an untrusted client.

    The whole point of BYOC is that file bytes never pass through the
    application server. A grant is what makes that literal: the server signs
    or opens an upload, hands the browser this object, and the browser
    transfers the bytes straight to the user's own cloud.

    It is deliberately plain data -- JSON-serializable, no methods, none of the
    application's own credentials -- so it can be returned from an API route
    and consumed by ``@byoc/browser``.

    Providers reach the same shape by different routes: S3 signs a PUT URL,
    Google Drive opens a resumable session whose URI is itself the capability.
    Neither requires the client to hold a long-lived secret.
    """

    provider: str
    path: str
    url: str
    """Absolute URL the client uploads to. Treat as a secret: it IS the capability."""
    method: str
    headers: Mapping[str, str] = field(default_factory=dict)
    protocol: str = "single"
    """``single`` sends the whole body at once; ``resumable`` allows chunking."""
    expires_at: datetime | None = None
    chunk_size: int | None = None
    max_bytes: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form, for returning straight from an API route.

        Absent optional fields are omitted rather than serialized as ``null``.
        A JSON ``null`` means "not applicable" to a Python reader and is a
        present-but-empty value to a JavaScript one, and that mismatch is a
        real bug: a ``null`` max_bytes once made the browser client reject
        every upload, because ``size > null`` is true in JavaScript.
        """
        payload: dict[str, Any] = {
            "provider": self.provider,
            "path": self.path,
            "url": self.url,
            "method": self.method,
            "headers": dict(self.headers),
            "protocol": self.protocol,
        }
        if self.expires_at is not None:
            payload["expiresAt"] = self.expires_at.isoformat()
        if self.chunk_size is not None:
            payload["chunkSize"] = self.chunk_size
        if self.max_bytes is not None:
            payload["maxBytes"] = self.max_bytes
        return payload


@dataclass(frozen=True, slots=True)
class UploadGrantOptions:
    """Options when minting an :class:`UploadGrant`."""

    expires_in_seconds: int = 900
    """Keep it short; the grant is a bearer capability."""
    mime_type: str | None = None
    size_bytes: int | None = None
    """Total size. Some providers require it up front."""


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
