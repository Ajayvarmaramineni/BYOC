"""Local filesystem storage adapter.

The provider that needs no account, no network, and no credentials. It exists
so BYOC can be evaluated, tested, and developed against before anyone signs up
for anything, and so a self-hosted deployment can use a mounted volume as
first-class storage rather than a special case.

Blocking file I/O runs in a worker thread, so this adapter is safe to use on an
event loop alongside the network-backed ones.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import shutil
from collections.abc import AsyncIterator, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..errors import (
    InvalidInputError,
    ObjectNotFoundError,
    PermissionDeniedError,
    StorageError,
)
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

PROVIDER_ID = "local"

# Sidecar metadata lives under a single dotted directory at the root, so a
# caller's own files are never shadowed and listings stay clean.
SIDECAR_DIR = ".byoc"

READ_CHUNK_SIZE = 64 * 1024


class LocalFileSystemProvider:
    """Stores objects as real files under ``root_directory``.

    Args:
        root_directory: Directory that backs this provider. Created if missing.
        create_root: Set ``False`` to require the directory to already exist.

    Every path is confined to ``root_directory``. Paths are resolved before use
    and rechecked afterwards, so neither ``..`` nor a symlink can escape.
    """

    def __init__(self, root_directory: str | os.PathLike[str], *, create_root: bool = True) -> None:
        self.root = Path(root_directory).expanduser()
        self._create_root = create_root
        self._resolved_root: Path | None = None

    # -- identity ----------------------------------------------------------

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=PROVIDER_ID,
            name="Local Filesystem",
            category="self-hosted",
            authentication="local",
            supports_user_owned_storage=True,
            adapter_version="0.3.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        # No sharing and no public URLs: a local path is not reachable by a
        # browser, and pretending otherwise would break feature detection.
        return ProviderCapabilities(
            folders=True,
            sharing=False,
            public_urls=False,
            resumable_uploads=False,
            versioning=False,
            quota=True,
            server_side_copy=True,
        )

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        def prepare() -> Path:
            if self._create_root:
                self.root.mkdir(parents=True, exist_ok=True)
            elif not self.root.is_dir():
                raise InvalidInputError(
                    f"Local storage root does not exist: {self.root}", provider=PROVIDER_ID
                )
            return self.root.resolve()

        self._resolved_root = await asyncio.to_thread(prepare)

    async def disconnect(self) -> None:
        # Nothing to release: there is no connection and no cached handle.
        self._resolved_root = None

    # -- path handling -----------------------------------------------------

    def _root_or_raise(self) -> Path:
        if self._resolved_root is None:
            # Resolve lazily so a caller who forgets connect() still gets
            # correct behaviour rather than a confusing AttributeError.
            self._resolved_root = self.root.expanduser().resolve()
        return self._resolved_root

    def _to_local(self, virtual_path: str) -> Path:
        """Virtual path -> absolute filesystem path, confined to the root.

        ``normalize_virtual_path`` already rejects ``..``. This adds the check
        that survives symlinks, which traversal filtering alone cannot catch:
        the resolved target must still sit inside the resolved root.
        """
        normalized = normalize_virtual_path(virtual_path)
        root = self._root_or_raise()
        candidate = (root / normalized) if normalized else root

        # `strict=False` so this works for paths being created, not just
        # existing ones. Symlinks along the way are still followed.
        resolved = candidate.resolve()
        if resolved != root and root not in resolved.parents:
            raise PermissionDeniedError(
                f'Path "{virtual_path}" resolves outside the storage root.',
                provider=PROVIDER_ID,
            )
        return resolved

    def _to_virtual(self, local_path: Path) -> str:
        return local_path.relative_to(self._root_or_raise()).as_posix()

    # -- sidecar metadata --------------------------------------------------

    def _sidecar_for(self, normalized: str) -> Path:
        root = self._root_or_raise()
        return root / SIDECAR_DIR / f"{normalized}.json"

    def _read_sidecar(self, normalized: str) -> dict[str, Any]:
        sidecar = self._sidecar_for(normalized)
        try:
            loaded: dict[str, Any] = json.loads(sidecar.read_text("utf-8"))
            return loaded
        except (OSError, ValueError):
            # A missing or unreadable sidecar is not an error: the file itself
            # is the source of truth, and metadata is supplementary.
            return {}

    def _write_sidecar(
        self, normalized: str, mime_type: str | None, metadata: Mapping[str, str]
    ) -> None:
        if not mime_type and not metadata:
            return
        sidecar = self._sidecar_for(normalized)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(
            json.dumps({"mime_type": mime_type, "metadata": dict(metadata)}), "utf-8"
        )

    def _delete_sidecar(self, normalized: str) -> None:
        self._sidecar_for(normalized).unlink(missing_ok=True)

    # -- object construction -----------------------------------------------

    def _to_object(self, local_path: Path, normalized: str) -> StorageObject:
        stat = local_path.stat()
        is_dir = local_path.is_dir()
        sidecar = {} if is_dir else self._read_sidecar(normalized)

        mime = sidecar.get("mime_type")
        if not mime and not is_dir:
            mime = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"

        return StorageObject(
            id=f"local_{normalized or ''}",
            path=normalized,
            name=get_basename(normalized) or local_path.name,
            provider=PROVIDER_ID,
            provider_id=str(local_path),
            type="folder" if is_dir else "file",
            size=None if is_dir else stat.st_size,
            mime_type=None if is_dir else mime,
            created_at=datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc),
            updated_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            metadata=sidecar.get("metadata", {}),
        )

    @staticmethod
    def _map_os_error(error: OSError, path: str) -> StorageError:
        if isinstance(error, FileNotFoundError):
            return ObjectNotFoundError(f"Local file not found: {path}", provider=PROVIDER_ID)
        if isinstance(error, (PermissionError, IsADirectoryError, NotADirectoryError)):
            return PermissionDeniedError(
                f"Local filesystem refused the operation on {path}: {error.strerror}",
                provider=PROVIDER_ID,
            )
        return StorageError(
            f"Local filesystem error on {path}: {error.strerror or error}",
            provider=PROVIDER_ID,
        )

    # -- core operations ---------------------------------------------------

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Upload requires a file path.", provider=PROVIDER_ID)

        target = self._to_local(normalized)
        resolved = options or UploadOptions()

        payload: bytes | None
        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, (bytes, bytearray, memoryview)):
            payload = bytes(data)
        else:
            payload = None  # async iterator: written chunk by chunk below

        def write_bytes(body: bytes) -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)

        try:
            if payload is not None:
                await asyncio.to_thread(write_bytes, payload)
                written = len(payload)
            else:
                written = await self._write_stream(target, data)  # type: ignore[arg-type]

            await asyncio.to_thread(
                self._write_sidecar, normalized, resolved.mime_type, resolved.metadata
            )
        except OSError as error:
            raise self._map_os_error(error, normalized) from error

        if resolved.on_progress:
            resolved.on_progress(
                UploadProgress(bytes_uploaded=written, total_bytes=written, percentage=100.0)
            )

        return await asyncio.to_thread(self._to_object, target, normalized)

    async def _write_stream(self, target: Path, chunks: AsyncIterator[bytes]) -> int:
        """Write an async iterator to disk without buffering the whole payload."""

        def open_target() -> Any:
            target.parent.mkdir(parents=True, exist_ok=True)
            return target.open("wb")

        handle = await asyncio.to_thread(open_target)
        written = 0
        try:
            async for chunk in chunks:
                await asyncio.to_thread(handle.write, chunk)
                written += len(chunk)
        finally:
            await asyncio.to_thread(handle.close)
        return written

    async def download(self, path: str) -> StorageOutput:
        normalized = normalize_virtual_path(path)
        target = self._to_local(normalized)

        if not await asyncio.to_thread(target.is_file):
            raise ObjectNotFoundError(
                f"Local file not found: {normalized}", provider=PROVIDER_ID
            )

        metadata = await asyncio.to_thread(self._to_object, target, normalized)

        async def stream() -> AsyncIterator[bytes]:
            handle = await asyncio.to_thread(target.open, "rb")
            try:
                while True:
                    chunk = await asyncio.to_thread(handle.read, READ_CHUNK_SIZE)
                    if not chunk:
                        return
                    yield chunk
            finally:
                await asyncio.to_thread(handle.close)

        async def read() -> bytes:
            return await asyncio.to_thread(target.read_bytes)

        return StorageOutput(metadata=metadata, stream=stream, read=read)

    async def delete(self, path: str) -> None:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Delete requires a path.", provider=PROVIDER_ID)
        target = self._to_local(normalized)

        def remove() -> None:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                # Deletion is idempotent, matching every other adapter.
                target.unlink(missing_ok=True)
            self._delete_sidecar(normalized)

        try:
            await asyncio.to_thread(remove)
        except OSError as error:
            raise self._map_os_error(error, normalized) from error

    async def exists(self, path: str) -> bool:
        normalized = normalize_virtual_path(path)
        if not normalized:
            return False
        return await asyncio.to_thread(self._to_local(normalized).exists)

    async def metadata(self, path: str) -> StorageObject:
        normalized = normalize_virtual_path(path)
        target = self._to_local(normalized)

        if not await asyncio.to_thread(target.exists):
            raise ObjectNotFoundError(
                f"Local file not found: {normalized}", provider=PROVIDER_ID
            )
        return await asyncio.to_thread(self._to_object, target, normalized)

    async def list(self, path: str | None = None) -> list[StorageObject]:
        normalized = normalize_virtual_path(path)
        target = self._to_local(normalized)

        def scan() -> list[StorageObject]:
            if not target.is_dir():
                raise ObjectNotFoundError(
                    f"Local folder not found: {normalized}", provider=PROVIDER_ID
                )
            results: list[StorageObject] = []
            for entry in sorted(target.iterdir(), key=lambda item: item.name):
                # The sidecar store is an implementation detail, not content.
                if entry.name == SIDECAR_DIR and entry.parent == self._root_or_raise():
                    continue
                child = f"{normalized}/{entry.name}" if normalized else entry.name
                results.append(self._to_object(entry, child))
            return results

        try:
            return await asyncio.to_thread(scan)
        except OSError as error:
            raise self._map_os_error(error, normalized) from error

    # -- capability-gated operations ---------------------------------------

    async def create_folder(self, path: str) -> StorageObject:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Create folder requires a path.", provider=PROVIDER_ID)
        target = self._to_local(normalized)

        try:
            await asyncio.to_thread(lambda: target.mkdir(parents=True, exist_ok=True))
        except OSError as error:
            raise self._map_os_error(error, normalized) from error

        return await asyncio.to_thread(self._to_object, target, normalized)

    async def copy(self, source: str, destination: str) -> None:
        src_norm = normalize_virtual_path(source)
        dst_norm = normalize_virtual_path(destination)
        if not src_norm or not dst_norm:
            raise InvalidInputError(
                "Copy requires both a source and a destination path.", provider=PROVIDER_ID
            )
        src, dst = self._to_local(src_norm), self._to_local(dst_norm)

        def do_copy() -> None:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
                sidecar = self._read_sidecar(src_norm)
                if sidecar:
                    self._write_sidecar(
                        dst_norm, sidecar.get("mime_type"), sidecar.get("metadata", {})
                    )

        try:
            await asyncio.to_thread(do_copy)
        except OSError as error:
            raise self._map_os_error(error, src_norm) from error

    async def move(self, source: str, destination: str) -> None:
        src_norm = normalize_virtual_path(source)
        dst_norm = normalize_virtual_path(destination)
        if not src_norm or not dst_norm:
            raise InvalidInputError(
                "Move requires both a source and a destination path.", provider=PROVIDER_ID
            )
        src, dst = self._to_local(src_norm), self._to_local(dst_norm)

        def do_move() -> None:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            sidecar = self._read_sidecar(src_norm)
            if sidecar:
                self._write_sidecar(
                    dst_norm, sidecar.get("mime_type"), sidecar.get("metadata", {})
                )
                self._delete_sidecar(src_norm)

        try:
            await asyncio.to_thread(do_move)
        except OSError as error:
            raise self._map_os_error(error, src_norm) from error

    async def quota(self) -> StorageQuota:
        """Report the backing filesystem's usage, not this directory's."""

        def usage() -> StorageQuota:
            total, used, free = shutil.disk_usage(self._root_or_raise())
            return StorageQuota(used=used, total=total, available=free)

        return await asyncio.to_thread(usage)


__all__ = ["PROVIDER_ID", "LocalFileSystemProvider"]
