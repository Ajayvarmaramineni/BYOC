"""Virtual path <-> Drive file ID resolution.

Google Drive addresses files by opaque IDs, not paths, so every operation on
``users/123/report.pdf`` costs a chain of lookups. This module caches those
lookups and self-heals when a user renames or deletes something in the Drive web
UI behind our back.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

from ...errors import ObjectNotFoundError
from ...paths import get_basename, get_dirname, normalize_virtual_path, split_path

FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"

# The metadata key BYOC writes into Drive's appProperties.
#
# This is WIRE FORMAT shared with every other BYOC SDK -- see
# spec/fixtures/provider-metadata.json. It stays camelCase in Python on purpose:
# renaming it would make files written here invisible to the TypeScript SDK.
VIRTUAL_PATH_PROPERTY = "byocVirtualPath"

DEFAULT_CACHE_TTL_SECONDS = 300.0
DEFAULT_CACHE_MAX_ENTRIES = 1000


def escape_drive_query_value(value: str) -> str:
    """Escape a value for a Drive API v3 query string literal.

    Drive requires ``\\`` and ``'`` to be backslash-escaped. Without this, a file
    named ``Bob's Notes.pdf`` produces a malformed query -- and a crafted name
    could inject query clauses and match files it should not.

    The order matters: backslashes first, or the escapes added for quotes get
    escaped a second time.
    """
    return value.replace("\\", "\\\\").replace("'", "\\'")


@dataclass(slots=True)
class _CacheEntry:
    file_id: str
    expires_at: float


class LruTtlPathCache:
    """Small LRU cache with a TTL, mapping virtual paths to Drive file IDs.

    The TTL bounds how long a stale mapping can survive an out-of-band change;
    the LRU bound stops a long-lived process from growing without limit.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_CACHE_TTL_SECONDS,
        max_entries: int = DEFAULT_CACHE_MAX_ENTRIES,
    ) -> None:
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, _CacheEntry] = {}

    def get(self, path: str) -> str | None:
        entry = self._entries.get(path)
        if entry is None:
            return None
        if time.monotonic() >= entry.expires_at:
            del self._entries[path]
            return None
        # Refresh recency for the LRU ordering.
        self._entries[path] = self._entries.pop(path)
        return entry.file_id

    def set(self, path: str, file_id: str) -> None:
        if path in self._entries:
            del self._entries[path]
        elif len(self._entries) >= self._max_entries:
            oldest = next(iter(self._entries))
            del self._entries[oldest]
        self._entries[path] = _CacheEntry(
            file_id=file_id, expires_at=time.monotonic() + self._ttl
        )

    def invalidate(self, path: str) -> None:
        """Drop a path and everything beneath it.

        Descendants go too: if ``a/b`` moved, every cached ``a/b/...`` id is
        suspect even though the ids themselves may still be valid.
        """
        self._entries.pop(path, None)
        prefix = f"{path}/"
        for key in [k for k in self._entries if k.startswith(prefix)]:
            del self._entries[key]

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


class DrivePathResolver:
    """Resolves virtual paths to Drive file IDs, creating folders on demand.

    Args:
        http: The Drive HTTP client used for lookups.
        root_folder_name: Application folder created at the Drive root.
        cache: Optional cache override.
    """

    def __init__(
        self,
        http: DriveHttpProtocol,
        *,
        root_folder_name: str = "BYOC",
        cache: LruTtlPathCache | None = None,
    ) -> None:
        self._http = http
        self._root_folder_name = root_folder_name
        self._cache = cache or LruTtlPathCache()
        self._root_id: str | None = None

    @property
    def cache(self) -> LruTtlPathCache:
        return self._cache

    def invalidate(self, path: str) -> None:
        """Forget a cached mapping, e.g. after a 404 or a move."""
        self._cache.invalidate(normalize_virtual_path(path))

    async def ensure_root_folder(self) -> str:
        """Return the app root folder id, creating it if absent."""
        if self._root_id is not None:
            return self._root_id

        escaped = escape_drive_query_value(self._root_folder_name)
        query = (
            f"name = '{escaped}' and 'root' in parents "
            f"and mimeType = '{FOLDER_MIME_TYPE}' and trashed = false"
        )
        found = await self._http.list_files(query, page_size=1)
        if found:
            self._root_id = str(found[0]["id"])
        else:
            self._root_id = await self._http.create_folder(self._root_folder_name, "root")
        return self._root_id

    async def resolve_folder_id(self, path: str, *, create: bool = False) -> str:
        """Resolve a folder path to its Drive id.

        Args:
            create: Create missing folders instead of raising.
        """
        normalized = normalize_virtual_path(path)
        if not normalized:
            return await self.ensure_root_folder()

        cached = self._cache.get(normalized)
        if cached is not None:
            return cached

        parent_id = await self.ensure_root_folder()
        walked = ""

        for segment in split_path(normalized):
            walked = f"{walked}/{segment}" if walked else segment

            cached_segment = self._cache.get(walked)
            if cached_segment is not None:
                parent_id = cached_segment
                continue

            escaped = escape_drive_query_value(segment)
            query = (
                f"name = '{escaped}' and '{parent_id}' in parents "
                f"and mimeType = '{FOLDER_MIME_TYPE}' and trashed = false"
            )
            matches = await self._http.list_files(query, page_size=1)

            if matches:
                parent_id = str(matches[0]["id"])
            elif create:
                parent_id = await self._http.create_folder(segment, parent_id)
            else:
                raise ObjectNotFoundError(
                    f"Folder not found in Google Drive: {walked}", provider="google-drive"
                )

            self._cache.set(walked, parent_id)

        return parent_id

    async def resolve_parent_folder_id(self, path: str, *, create: bool = True) -> str:
        """Resolve the parent folder of a file path."""
        return await self.resolve_folder_id(get_dirname(path), create=create)

    async def resolve_file_id(self, path: str) -> str:
        """Resolve a file path to its Drive id.

        Raises:
            ObjectNotFoundError: if no matching untrashed file exists.
        """
        normalized = normalize_virtual_path(path)
        if not normalized:
            return await self.ensure_root_folder()

        cached = self._cache.get(normalized)
        if cached is not None:
            return cached

        parent_id = await self.resolve_folder_id(get_dirname(normalized), create=False)
        filename = get_basename(normalized)
        escaped = escape_drive_query_value(filename)
        query = f"name = '{escaped}' and '{parent_id}' in parents and trashed = false"

        matches = await self._http.list_files(query, page_size=10)
        if not matches:
            raise ObjectNotFoundError(
                f"File not found in Google Drive: {normalized}", provider="google-drive"
            )

        file_id = str(matches[0]["id"])
        self._cache.set(normalized, file_id)
        return file_id


class DriveHttpProtocol(Protocol):
    """The subset of the Drive HTTP client the resolver needs.

    A structural protocol, so the resolver can be exercised without HTTP.
    """

    async def list_files(self, query: str, page_size: int = 100) -> list[dict[str, Any]]: ...

    async def create_folder(self, name: str, parent_id: str) -> str: ...
