"""The universal BYOC client.

Applications talk to :class:`AsyncBYOC`; it routes to whichever provider adapter
is active. Provider-specific concepts -- Drive file IDs, S3 keys, WebDAV
collections -- never surface here.
"""

from __future__ import annotations

import asyncio
import mimetypes
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, timezone

from .errors import CapabilityUnsupportedError, InvalidInputError, StorageError
from .logging import BYOCLogger, SilentLogger
from .migration import MigrationReport, ProgressCallback, migrate
from .paths import normalize_virtual_path
from .types import (
    BackupOptions,
    BatchDeleteReport,
    BatchFailure,
    BYOCProvider,
    ConflictStrategy,
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadOptions,
)

DEFAULT_MIME_TYPE = "application/octet-stream"


def lookup_mime_type(path: str, fallback: str = DEFAULT_MIME_TYPE) -> str:
    """Guess a MIME type from a path, falling back rather than returning None."""
    guessed, _ = mimetypes.guess_type(path)
    return guessed or fallback


class AsyncBYOC:
    """Universal client for user-owned, self-hosted, and multi-cloud storage.

    Args:
        provider: A single provider adapter.
        providers: Several adapters, for runtime switching and migration.
        default_provider_id: Which registered provider starts active.
        logger: Where to log. Defaults to silent so importing BYOC is quiet.
        max_file_size_bytes: Reject in-memory uploads larger than this.

    At least one of ``provider`` or ``providers`` is required.
    """

    def __init__(
        self,
        *,
        provider: BYOCProvider | None = None,
        providers: Sequence[BYOCProvider] | None = None,
        default_provider_id: str | None = None,
        logger: BYOCLogger | None = None,
        max_file_size_bytes: int | None = None,
    ) -> None:
        registry: dict[str, BYOCProvider] = {}
        ordered: list[BYOCProvider] = []

        # `is not None`, not truthiness: an adapter is free to define __len__
        # or __bool__, and an empty one must still register.
        supplied: list[BYOCProvider] = [] if provider is None else [provider]
        for adapter in [*supplied, *(providers or [])]:
            ordered.append(adapter)
            registry[adapter.manifest().id] = adapter

        if not ordered:
            raise InvalidInputError(
                "BYOC initialization failed: at least one provider adapter must be supplied.",
                provider="core",
            )

        self._registry = registry
        self._logger = logger or SilentLogger()
        self._max_file_size_bytes = max_file_size_bytes

        if default_provider_id and default_provider_id in registry:
            self._current = registry[default_provider_id]
        else:
            self._current = ordered[0]

    # -- provider selection -------------------------------------------------

    def use_provider(self, provider_id: str) -> AsyncBYOC:
        """Switch the active provider. Returns ``self`` so calls can chain."""
        target = self._registry.get(provider_id)
        if target is None:
            available = ", ".join(sorted(self._registry)) or "none"
            raise InvalidInputError(
                f"Provider '{provider_id}' is not registered in this BYOC client. "
                f"Available providers: [{available}]",
                provider="core",
            )
        self._current = target
        return self

    def get_providers(self) -> list[ProviderManifest]:
        """Manifests for every registered provider."""
        return [adapter.manifest() for adapter in self._registry.values()]

    def manifest(self) -> ProviderManifest:
        """Manifest of the active provider."""
        return self._current.manifest()

    def capabilities(self) -> ProviderCapabilities:
        """Capabilities of the active provider."""
        return self._current.capabilities()

    def has_capability(self, capability: str) -> bool:
        """Whether the active provider supports ``capability``."""
        return bool(getattr(self.capabilities(), capability, False))

    # -- lifecycle ----------------------------------------------------------

    async def connect(self) -> None:
        """Connect the active provider."""
        self._logger.debug("Connecting to provider: %s", self.manifest().id)
        await self._current.connect()

    async def disconnect(self) -> None:
        """Disconnect the active provider."""
        self._logger.debug("Disconnecting from provider: %s", self.manifest().id)
        await self._current.disconnect()

    async def connect_all(self) -> None:
        """Connect every registered provider, for multi-cloud use."""
        for adapter in self._registry.values():
            await adapter.connect()

    async def disconnect_all(self) -> None:
        """Disconnect every registered provider."""
        for adapter in self._registry.values():
            await adapter.disconnect()

    async def __aenter__(self) -> AsyncBYOC:
        await self.connect()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.disconnect()

    # -- core operations ----------------------------------------------------

    def _require_path(self, path: str, operation: str) -> str:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError(
                f"{operation} requires a valid non-empty file path.", provider=self.manifest().id
            )
        return normalized

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        """Upload ``data`` to ``path``, detecting the MIME type when not given."""
        normalized = self._require_path(path, "Upload")

        if self._max_file_size_bytes is not None:
            size: int | None = None
            if isinstance(data, str):
                size = len(data.encode("utf-8"))
            elif isinstance(data, bytes | bytearray | memoryview):
                size = len(bytes(data))
            if size is not None and size > self._max_file_size_bytes:
                raise InvalidInputError(
                    f"File size ({size} bytes) exceeds the configured maximum of "
                    f"{self._max_file_size_bytes} bytes.",
                    provider=self.manifest().id,
                )

        resolved = options or UploadOptions()
        if resolved.mime_type is None:
            resolved = UploadOptions(
                mime_type=lookup_mime_type(normalized),
                resumable=resolved.resumable,
                chunk_size=resolved.chunk_size,
                on_progress=resolved.on_progress,
                metadata=resolved.metadata,
            )

        self._logger.debug("Uploading to %s on %s", normalized, self.manifest().id)
        return await self._current.upload(normalized, data, resolved)

    async def write_text(
        self, path: str, content: str, options: UploadOptions | None = None
    ) -> StorageObject:
        """Upload a UTF-8 string."""
        resolved = options or UploadOptions()
        if resolved.mime_type is None:
            mime = lookup_mime_type(normalize_virtual_path(path), "text/plain; charset=utf-8")
            resolved = UploadOptions(
                mime_type=mime,
                resumable=resolved.resumable,
                chunk_size=resolved.chunk_size,
                on_progress=resolved.on_progress,
                metadata=resolved.metadata,
            )
        return await self.upload(path, content, resolved)

    async def write_bytes(
        self, path: str, data: bytes, options: UploadOptions | None = None
    ) -> StorageObject:
        """Upload raw bytes."""
        return await self.upload(path, data, options)

    async def download(self, path: str) -> StorageOutput:
        """Download the object at ``path``."""
        return await self._current.download(self._require_path(path, "Download"))

    async def read_text(self, path: str, encoding: str = "utf-8") -> str:
        """Download and decode an object as text."""
        return await (await self.download(path)).text(encoding)

    async def read_bytes(self, path: str) -> bytes:
        """Download an object as raw bytes."""
        return await (await self.download(path)).read()

    async def delete(self, path: str) -> None:
        """Delete the object at ``path``."""
        await self._current.delete(self._require_path(path, "Delete"))

    async def list(self, path: str | None = None) -> list[StorageObject]:
        """List objects under ``path``, or under the root if omitted."""
        return await self._current.list(normalize_virtual_path(path) or None)

    async def exists(self, path: str) -> bool:
        """Whether an object exists at ``path``. An empty path is never a file."""
        normalized = normalize_virtual_path(path)
        if not normalized:
            return False
        return await self._current.exists(normalized)

    async def metadata(self, path: str) -> StorageObject:
        """Metadata for the object at ``path``."""
        return await self._current.metadata(self._require_path(path, "Metadata lookup"))

    # -- capability-gated operations ---------------------------------------

    async def create_folder(self, path: str) -> StorageObject:
        """Create a folder, if the active provider has real folders."""
        create = getattr(self._current, "create_folder", None)
        if not self.capabilities().folders or create is None:
            raise CapabilityUnsupportedError(
                f"Provider '{self.manifest().name}' does not support explicit folder creation.",
                provider=self.manifest().id,
            )
        result: StorageObject = await create(self._require_path(path, "Create folder"))
        return result

    async def move(self, source: str, destination: str) -> None:
        """Move an object, if the active provider supports it natively."""
        mover = getattr(self._current, "move", None)
        if mover is None:
            raise CapabilityUnsupportedError(
                f"Provider '{self.manifest().name}' does not support native move operations.",
                provider=self.manifest().id,
            )
        await mover(
            self._require_path(source, "Move"), self._require_path(destination, "Move")
        )

    async def copy(self, source: str, destination: str) -> None:
        """Copy an object, if the active provider supports it natively.

        Every current adapter copies server-side, so the bytes never travel
        through this process.
        """
        copier = getattr(self._current, "copy", None)
        if copier is None:
            raise CapabilityUnsupportedError(
                f"Provider '{self.manifest().name}' does not support native copy operations.",
                provider=self.manifest().id,
            )
        await copier(
            self._require_path(source, "Copy"), self._require_path(destination, "Copy")
        )

    async def get_quota(self) -> StorageQuota:
        """Report storage quota, if the active provider exposes it."""
        quota = getattr(self._current, "quota", None)
        if not self.capabilities().quota or quota is None:
            raise CapabilityUnsupportedError(
                f"Provider '{self.manifest().name}' does not support quota reporting.",
                provider=self.manifest().id,
            )
        result: StorageQuota = await quota()
        return result

    async def signed_url(
        self, path: str, *, method: str = "GET", expires_in_seconds: int = 3600
    ) -> str:
        """A time-limited URL a browser can use directly, without proxying bytes.

        Only providers reporting ``public_urls`` can issue one. Google Drive
        and WebDAV cannot, so they raise rather than returning a URL that
        would need the caller's credentials to be useful.
        """
        signer = getattr(self._current, "signed_url", None)
        if not self.capabilities().public_urls or signer is None:
            raise CapabilityUnsupportedError(
                f"Provider '{self.manifest().name}' cannot issue signed URLs.",
                provider=self.manifest().id,
            )
        url: str = signer(
            self._require_path(path, "Signed URL"),
            method=method,
            expires_in_seconds=expires_in_seconds,
        )
        return url

    # -- recursive and batch operations ------------------------------------

    async def walk(self, path: str | None = None) -> AsyncIterator[StorageObject]:
        """Yield every object beneath ``path``, descending into folders.

        ``list`` returns one level, which is right for rendering a file
        browser and wrong for "everything under here". This walks the tree
        breadth-first, yielding folders before their contents.

        It is built on ``list``, so it costs one call per folder. On a flat
        provider like S3 or the in-memory one there are no folders to descend
        into, so it is a single call.
        """
        pending = [normalize_virtual_path(path) or None]

        while pending:
            current = pending.pop(0)
            for item in await self._current.list(current):
                yield item
                if item.type == "folder":
                    pending.append(item.path)

    async def delete_tree(self, path: str) -> BatchDeleteReport:
        """Delete everything under ``path``, then ``path`` itself.

        Children are deleted before their parents, so a provider that refuses
        to remove a non-empty folder still ends up with an empty one to
        remove. Failures are collected rather than aborting the walk.
        """
        normalized = self._require_path(path, "Delete tree")

        # Deepest first: a folder must be emptied before it can be removed.
        descendants = [item async for item in self.walk(normalized)]
        descendants.sort(key=lambda item: item.path.count("/"), reverse=True)

        targets = [item.path for item in descendants] + [normalized]
        return await self.delete_many(targets, concurrency=1)

    async def delete_many(
        self, paths: Sequence[str], *, concurrency: int = 8
    ) -> BatchDeleteReport:
        """Delete several paths, reporting per-path outcomes.

        One failure does not abort the rest: a locked or already-removed
        object is the common case, and the caller needs to know which paths
        survived rather than losing the whole batch.
        """
        if concurrency < 1:
            raise InvalidInputError(
                "delete_many concurrency must be at least 1.", provider=self.manifest().id
            )

        report = BatchDeleteReport()
        limit = asyncio.Semaphore(concurrency)

        async def remove(target: str) -> None:
            async with limit:
                try:
                    await self.delete(target)
                    report.deleted.append(target)
                except StorageError as error:
                    report.failed.append(
                        BatchFailure(path=target, error=str(error), code=error.code)
                    )

        await asyncio.gather(*(remove(target) for target in paths))
        return report

    # -- high-level helpers -------------------------------------------------

    async def backup(
        self, payload: StorageInput, options: BackupOptions | None = None
    ) -> StorageObject:
        """Write a timestamped backup file, defaulting to a ``Backups`` folder."""
        resolved = options or BackupOptions()
        folder = normalize_virtual_path(resolved.folder or "Backups")
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        filename = resolved.filename or f"backup-{stamp}.json"
        target = f"{folder}/{filename}" if folder else filename

        return await self.upload(
            target,
            payload,
            UploadOptions(
                mime_type=resolved.mime_type or "application/json",
                on_progress=resolved.on_progress,
            ),
        )

    async def migrate(
        self,
        *,
        source: str,
        target: str,
        paths: Sequence[str],
        conflict_strategy: ConflictStrategy = ConflictStrategy.OVERWRITE,
        concurrency: int = 4,
        delete_source_after_migrate: bool = False,
        on_progress: ProgressCallback | None = None,
    ) -> MigrationReport:
        """Transfer files between two registered providers.

        Args:
            source: Registered provider id to read from.
            target: Registered provider id to write to.
        """
        source_adapter = self._registry.get(source)
        target_adapter = self._registry.get(target)

        if source_adapter is None:
            raise InvalidInputError(
                f"Source provider '{source}' is not registered in this BYOC client.",
                provider="core",
            )
        if target_adapter is None:
            raise InvalidInputError(
                f"Destination provider '{target}' is not registered in this BYOC client.",
                provider="core",
            )

        return await migrate(
            source=source_adapter,
            target=target_adapter,
            paths=paths,
            conflict_strategy=conflict_strategy,
            concurrency=concurrency,
            delete_source_after_migrate=delete_source_after_migrate,
            on_progress=on_progress,
            logger=self._logger,
        )
