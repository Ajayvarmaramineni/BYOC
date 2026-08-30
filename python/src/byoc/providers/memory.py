"""In-memory storage adapter.

A test double that behaves like a real provider. Use it to unit-test code that
talks to BYOC without touching a disk, a network, or a credential, and to run
the same suite in CI that you run against a live backend.

It models a flat key-value object store, the shape S3 and R2 have, so code
verified against it behaves the same way against those. Nothing is persisted:
every instance starts empty and is discarded with the process.
"""

from __future__ import annotations

import asyncio
import mimetypes
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..errors import InvalidInputError, ObjectNotFoundError
from ..paths import get_basename, normalize_virtual_path
from ..types import (
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadOptions,
    UploadProgress,
)

PROVIDER_ID = "memory"

DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024


@dataclass
class _StoredObject:
    """One object's bytes and the metadata a real provider would return."""

    data: bytes
    mime_type: str
    created_at: datetime
    updated_at: datetime
    metadata: Mapping[str, str] = field(default_factory=dict)


class MemoryProvider:
    """Keeps every object in a dictionary.

    Args:
        quota_bytes: Total capacity to report. ``None`` reports usage only.
        stream_chunk_size: Bytes per chunk yielded by ``download().stream()``.
            Small values are useful for exercising a caller's chunk handling.

    Like S3, this provider has no real folders, so it reports
    ``folders=False`` and ``create_folder`` is not offered. Paths still nest:
    ``list("reports")`` returns everything one level under ``reports/``.
    """

    def __init__(
        self,
        *,
        quota_bytes: int | None = None,
        stream_chunk_size: int = DEFAULT_STREAM_CHUNK_SIZE,
    ) -> None:
        if stream_chunk_size < 1:
            raise InvalidInputError(
                "stream_chunk_size must be at least 1 byte.", provider=PROVIDER_ID
            )
        self._objects: dict[str, _StoredObject] = {}
        self._quota_bytes = quota_bytes
        self._stream_chunk_size = stream_chunk_size

    # -- identity ----------------------------------------------------------

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=PROVIDER_ID,
            name="In-Memory",
            category="self-hosted",
            authentication="local",
            supports_user_owned_storage=False,
            adapter_version="0.3.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            folders=False,
            sharing=False,
            public_urls=False,
            resumable_uploads=False,
            versioning=False,
            quota=True,
            server_side_copy=True,
        )

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        """No-op: there is nothing to connect to."""

    async def disconnect(self) -> None:
        """No-op. Stored objects survive, so a reconnect sees the same state."""

    # -- test helpers ------------------------------------------------------

    def clear(self) -> None:
        """Drop every stored object. Convenient between test cases."""
        self._objects.clear()

    def snapshot(self) -> dict[str, bytes]:
        """Every stored path and its bytes, for assertions in tests."""
        return {path: stored.data for path, stored in self._objects.items()}

    def __len__(self) -> int:
        return len(self._objects)

    # -- internals ---------------------------------------------------------

    def _to_object(self, path: str, stored: _StoredObject) -> StorageObject:
        return StorageObject(
            id=f"memory_{path}",
            path=path,
            name=get_basename(path),
            provider=PROVIDER_ID,
            provider_id=path,
            type="file",
            size=len(stored.data),
            mime_type=stored.mime_type,
            created_at=stored.created_at,
            updated_at=stored.updated_at,
            metadata=stored.metadata,
        )

    def _require(self, path: str, operation: str) -> tuple[str, _StoredObject]:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError(f"{operation} requires a path.", provider=PROVIDER_ID)
        stored = self._objects.get(normalized)
        if stored is None:
            raise ObjectNotFoundError(
                f"Object not found in memory storage: {normalized}", provider=PROVIDER_ID
            )
        return normalized, stored

    # -- core operations ---------------------------------------------------

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Upload requires a file path.", provider=PROVIDER_ID)

        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, (bytes, bytearray, memoryview)):
            payload = bytes(data)
        else:
            collected = bytearray()
            async for chunk in data:
                collected.extend(chunk)
            payload = bytes(collected)

        resolved = options or UploadOptions()
        now = datetime.now(timezone.utc)
        previous = self._objects.get(normalized)

        self._objects[normalized] = _StoredObject(
            data=payload,
            mime_type=resolved.mime_type
            or mimetypes.guess_type(normalized)[0]
            or "application/octet-stream",
            # Overwriting keeps the original creation time, as object stores do.
            created_at=previous.created_at if previous else now,
            updated_at=now,
            metadata=dict(resolved.metadata),
        )

        if resolved.on_progress:
            resolved.on_progress(
                UploadProgress(
                    bytes_uploaded=len(payload), total_bytes=len(payload), percentage=100.0
                )
            )

        return self._to_object(normalized, self._objects[normalized])

    async def download(self, path: str) -> StorageOutput:
        normalized, stored = self._require(path, "Download")
        payload = stored.data
        chunk_size = self._stream_chunk_size

        async def stream() -> AsyncIterator[bytes]:
            for offset in range(0, len(payload), chunk_size):
                # Yield to the loop so callers see real interleaving, as they
                # would against a network-backed provider.
                await asyncio.sleep(0)
                yield payload[offset : offset + chunk_size]

        async def read() -> bytes:
            return payload

        return StorageOutput(
            metadata=self._to_object(normalized, stored), stream=stream, read=read
        )

    async def delete(self, path: str) -> None:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Delete requires a path.", provider=PROVIDER_ID)
        # Idempotent, matching every other adapter.
        self._objects.pop(normalized, None)

    async def exists(self, path: str) -> bool:
        normalized = normalize_virtual_path(path)
        return bool(normalized) and normalized in self._objects

    async def metadata(self, path: str) -> StorageObject:
        normalized, stored = self._require(path, "Metadata lookup")
        return self._to_object(normalized, stored)

    async def list(self, path: str | None = None) -> list[StorageObject]:
        prefix = normalize_virtual_path(path)
        scope = f"{prefix}/" if prefix else ""

        results: list[StorageObject] = []
        seen_prefixes: set[str] = set()

        for stored_path, stored in self._objects.items():
            if not stored_path.startswith(scope):
                continue

            remainder = stored_path[len(scope) :]
            if "/" not in remainder:
                results.append(self._to_object(stored_path, stored))
                continue

            # Deeper keys surface as a synthetic folder for their first
            # segment, which is what S3 does with CommonPrefixes. Without it a
            # caller walking the tree cannot discover anything nested, and a
            # recursive delete would silently leave objects behind.
            child = f"{scope}{remainder.split('/', 1)[0]}"
            if child in seen_prefixes:
                continue
            seen_prefixes.add(child)
            results.append(
                StorageObject(
                    id=f"memory_{child}",
                    path=child,
                    name=get_basename(child),
                    provider=PROVIDER_ID,
                    provider_id=child,
                    type="folder",
                )
            )

        return sorted(results, key=lambda item: item.path)

    # -- capability-gated operations ---------------------------------------

    async def copy(self, source: str, destination: str) -> None:
        src_norm, stored = self._require(source, "Copy")
        dst_norm = normalize_virtual_path(destination)
        if not dst_norm:
            raise InvalidInputError("Copy requires a destination path.", provider=PROVIDER_ID)

        now = datetime.now(timezone.utc)
        self._objects[dst_norm] = _StoredObject(
            data=stored.data,
            mime_type=stored.mime_type,
            created_at=now,
            updated_at=now,
            metadata=dict(stored.metadata),
        )
        _ = src_norm

    async def move(self, source: str, destination: str) -> None:
        await self.copy(source, destination)
        await self.delete(source)

    async def quota(self) -> StorageQuota:
        used = sum(len(stored.data) for stored in self._objects.values())
        if self._quota_bytes is None:
            return StorageQuota(used=used)
        return StorageQuota(
            used=used, total=self._quota_bytes, available=max(self._quota_bytes - used, 0)
        )


__all__ = ["PROVIDER_ID", "MemoryProvider"]
