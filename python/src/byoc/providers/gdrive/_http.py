"""Google Drive API v3 HTTP client.

Owns Drive's wire concerns: multipart and resumable upload framing, the
``fields`` projections, and mapping Drive's error shapes onto BYOC errors.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from typing import Any

import httpx

from ...errors import (
    AuthRequiredError,
    ObjectNotFoundError,
    PermissionDeniedError,
    ProviderUnavailableError,
    QuotaExceededError,
    RateLimitedError,
    StorageError,
)
from ...types import StorageObject, StorageQuota, UploadProgress
from ._resolver import FOLDER_MIME_TYPE, VIRTUAL_PATH_PROPERTY

API_BASE = "https://www.googleapis.com/drive/v3"
UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"

FILE_FIELDS = (
    "id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,trashed,appProperties"
)

# Drive requires resumable chunks to be a multiple of 256 KiB (except the last).
_UPLOAD_FRAME_SIZE = 64 * 1024
"""Bytes handed to httpx at a time. Small enough that CPython reuses the block."""

CHUNK_ALIGNMENT = 256 * 1024
DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024
# Above this, upload resumably so a dropped connection does not restart from zero.
RESUMABLE_THRESHOLD = 5 * 1024 * 1024


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class DriveHttpClient:
    """Authenticated Drive API client.

    Args:
        token_provider: Async callable returning a valid access token. Called
            per request so a refresh mid-session is picked up automatically.
        client: An ``httpx.AsyncClient`` to reuse.
    """

    def __init__(
        self,
        token_provider: Callable[[], Any],
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._token_provider = token_provider
        self._client = client
        self._owns_client = client is None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
            self._owns_client = True
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        token = await self._token_provider()
        return {"Authorization": f"Bearer {token}", **(extra or {})}

    # -- error mapping -----------------------------------------------------

    def map_error(self, response: httpx.Response) -> StorageError:
        status = response.status_code
        reason = ""
        message = ""
        try:
            body = response.json().get("error", {})
            message = str(body.get("message", ""))
            errors = body.get("errors") or []
            if errors:
                reason = str(errors[0].get("reason", ""))
        except (ValueError, AttributeError):
            message = response.text[:200]

        if status == 401:
            return AuthRequiredError(
                f"Google Drive authentication failed: {message}",
                provider="google-drive",
                status_code=status,
            )
        if status == 404:
            return ObjectNotFoundError(
                f"Google Drive resource not found: {message}",
                provider="google-drive",
                status_code=status,
            )
        if status == 403:
            # 403 is overloaded: quota and rate limits share it with real denials.
            if reason in ("storageQuotaExceeded", "quotaExceeded"):
                return QuotaExceededError(
                    f"Google Drive quota exceeded: {message}",
                    provider="google-drive",
                    status_code=status,
                )
            if reason in ("rateLimitExceeded", "userRateLimitExceeded"):
                return RateLimitedError(
                    f"Google Drive rate limit exceeded: {message}",
                    provider="google-drive",
                    status_code=status,
                )
            return PermissionDeniedError(
                f"Google Drive permission denied: {message}",
                provider="google-drive",
                status_code=status,
            )
        if status == 429:
            return RateLimitedError(
                f"Google Drive rate limit exceeded: {message}",
                provider="google-drive",
                status_code=status,
            )
        return ProviderUnavailableError(
            f"Google Drive error (HTTP {status}): {message}",
            provider="google-drive",
            status_code=status,
            retryable=status >= 500,
        )

    def to_storage_object(self, resource: dict[str, Any], path: str) -> StorageObject:
        """Convert a Drive file resource into a provider-neutral StorageObject."""
        is_folder = resource.get("mimeType") == FOLDER_MIME_TYPE
        size = resource.get("size")
        properties = resource.get("appProperties") or {}

        return StorageObject(
            id=f"gdrive_{resource['id']}",
            path=path,
            name=str(resource.get("name", "")),
            provider="google-drive",
            provider_id=str(resource["id"]),
            type="folder" if is_folder else "file",
            size=int(size) if size is not None and not is_folder else None,
            mime_type=str(resource.get("mimeType")) if resource.get("mimeType") else None,
            checksum=str(resource["md5Checksum"]) if resource.get("md5Checksum") else None,
            created_at=_parse_time(resource.get("createdTime")),
            updated_at=_parse_time(resource.get("modifiedTime")),
            metadata={k: v for k, v in properties.items() if k != VIRTUAL_PATH_PROPERTY},
        )

    # -- metadata operations ----------------------------------------------

    async def list_files(self, query: str, page_size: int = 100) -> list[dict[str, Any]]:
        """Run a Drive query, following pagination."""
        results: list[dict[str, Any]] = []
        page_token: str | None = None

        while True:
            params = {
                "q": query,
                "pageSize": str(min(page_size, 1000)),
                "fields": f"nextPageToken,files({FILE_FIELDS})",
                "spaces": "drive",
            }
            if page_token:
                params["pageToken"] = page_token

            response = await self._http().get(
                f"{API_BASE}/files", params=params, headers=await self._headers()
            )
            if response.is_error:
                raise self.map_error(response)

            payload = response.json()
            results.extend(payload.get("files", []))

            page_token = payload.get("nextPageToken")
            if not page_token or len(results) >= page_size:
                break

        return results

    async def get_file(self, file_id: str) -> dict[str, Any]:
        response = await self._http().get(
            f"{API_BASE}/files/{file_id}",
            params={"fields": FILE_FIELDS},
            headers=await self._headers(),
        )
        if response.is_error:
            raise self.map_error(response)
        resource: dict[str, Any] = response.json()
        return resource

    async def create_folder(self, name: str, parent_id: str) -> str:
        body = {"name": name, "mimeType": FOLDER_MIME_TYPE, "parents": [parent_id]}
        response = await self._http().post(
            f"{API_BASE}/files",
            params={"fields": "id"},
            headers=await self._headers({"Content-Type": "application/json"}),
            content=json.dumps(body).encode("utf-8"),
        )
        if response.is_error:
            raise self.map_error(response)
        return str(response.json()["id"])

    async def copy_file(
        self, file_id: str, new_name: str, parent_id: str
    ) -> dict[str, Any]:
        """Server-side copy. Drive duplicates the blob without re-uploading."""
        body = {"name": new_name, "parents": [parent_id]}
        response = await self._http().post(
            f"{API_BASE}/files/{file_id}/copy",
            params={"fields": FILE_FIELDS},
            headers=await self._headers({"Content-Type": "application/json"}),
            content=json.dumps(body).encode("utf-8"),
        )
        if response.is_error:
            raise self.map_error(response)
        resource: dict[str, Any] = response.json()
        return resource

    async def move_file(
        self, file_id: str, new_parent_id: str, old_parent_id: str, new_name: str
    ) -> dict[str, Any]:
        """Reparent and rename in one PATCH.

        Drive models a move as an edit to the file's parent list rather than a
        rename, so this is instantaneous regardless of file size.
        """
        params = {
            "addParents": new_parent_id,
            "removeParents": old_parent_id,
            "fields": FILE_FIELDS,
        }
        response = await self._http().patch(
            f"{API_BASE}/files/{file_id}",
            params=params,
            headers=await self._headers({"Content-Type": "application/json"}),
            content=json.dumps({"name": new_name}).encode("utf-8"),
        )
        if response.is_error:
            raise self.map_error(response)
        resource: dict[str, Any] = response.json()
        return resource

    async def delete_file(self, file_id: str) -> None:
        response = await self._http().delete(
            f"{API_BASE}/files/{file_id}", headers=await self._headers()
        )
        if response.is_error and response.status_code != 404:
            raise self.map_error(response)

    async def download_file(self, file_id: str) -> bytes:
        response = await self._http().get(
            f"{API_BASE}/files/{file_id}",
            params={"alt": "media"},
            headers=await self._headers(),
        )
        if response.is_error:
            raise self.map_error(response)
        return response.content

    async def get_quota(self) -> StorageQuota:
        response = await self._http().get(
            f"{API_BASE}/about",
            params={"fields": "storageQuota"},
            headers=await self._headers(),
        )
        if response.is_error:
            raise self.map_error(response)

        quota = response.json().get("storageQuota", {})
        used = int(quota.get("usage", 0))
        limit = quota.get("limit")
        total = int(limit) if limit is not None else None
        return StorageQuota(
            used=used, total=total, available=(total - used) if total is not None else None
        )

    # -- uploads -----------------------------------------------------------

    def build_metadata(
        self,
        *,
        name: str,
        parent_id: str,
        virtual_path: str,
        mime_type: str | None,
        extra: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Build the file metadata, including the shared virtual-path property."""
        return {
            "name": name,
            "parents": [parent_id],
            **({"mimeType": mime_type} if mime_type else {}),
            "appProperties": {VIRTUAL_PATH_PROPERTY: virtual_path, **(extra or {})},
        }

    async def multipart_upload(
        self, metadata: dict[str, Any], payload: bytes, mime_type: str
    ) -> dict[str, Any]:
        """Upload metadata and content in a single multipart/related request."""
        boundary = "byoc-boundary-Xk3Jd9Qm2Lp7"
        body = b"".join(
            [
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode(),
                json.dumps(metadata).encode("utf-8"),
                f"\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n".encode(),
                payload,
                f"\r\n--{boundary}--".encode(),
            ]
        )

        response = await self._http().post(
            f"{UPLOAD_BASE}/files",
            params={"uploadType": "multipart", "fields": FILE_FIELDS},
            headers=await self._headers(
                {"Content-Type": f"multipart/related; boundary={boundary}"}
            ),
            content=body,
        )
        if response.is_error:
            raise self.map_error(response)
        resource: dict[str, Any] = response.json()
        return resource

    async def start_resumable_upload(self, metadata: dict[str, Any], mime_type: str) -> str:
        """Begin a resumable session and return its upload URL."""
        response = await self._http().post(
            f"{UPLOAD_BASE}/files",
            params={"uploadType": "resumable", "fields": FILE_FIELDS},
            headers=await self._headers(
                {
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Type": mime_type,
                }
            ),
            content=json.dumps(metadata).encode("utf-8"),
        )
        if response.is_error:
            raise self.map_error(response)

        location: str | None = response.headers.get("location")
        if not location:
            raise ProviderUnavailableError(
                "Google Drive did not return a resumable upload URL.", provider="google-drive"
            )
        return str(location)

    async def upload_chunks(
        self,
        upload_url: str,
        payload: bytes,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        on_progress: Callable[[UploadProgress], None] | None = None,
    ) -> dict[str, Any]:
        """Send a payload in 256 KiB-aligned chunks to a resumable session."""
        aligned = max(CHUNK_ALIGNMENT, (chunk_size // CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT)
        total = len(payload)
        offset = 0

        while offset < total:
            end = min(offset + aligned, total)
            chunk = payload[offset:end]

            response = await self._http().put(
                upload_url,
                headers={
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {offset}-{end - 1}/{total}",
                },
                content=chunk,
            )

            # 308 Resume Incomplete is the success signal for a non-final chunk.
            if response.status_code in (200, 201):
                if on_progress:
                    on_progress(
                        UploadProgress(
                            bytes_uploaded=total, total_bytes=total, percentage=100.0
                        )
                    )
                resource: dict[str, Any] = response.json()
                return resource

            if response.status_code != 308:
                raise self.map_error(response)

            # Trust the server's committed range over our own bookkeeping.
            committed = response.headers.get("range")
            offset = int(committed.split("-")[-1]) + 1 if committed else end

            if on_progress:
                on_progress(
                    UploadProgress(
                        bytes_uploaded=offset,
                        total_bytes=total,
                        percentage=round(offset / total * 100, 2) if total else 100.0,
                    )
                )

        raise ProviderUnavailableError(
            "Resumable upload ended without a completion response.", provider="google-drive"
        )

    async def stream_chunks(
        self,
        upload_url: str,
        source: AsyncIterator[bytes],
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        on_progress: Callable[[UploadProgress], None] | None = None,
    ) -> dict[str, Any]:
        """Send an async iterator to a resumable session without buffering it.

        Drive accepts ``Content-Range: bytes {start}-{end}/*`` while the total
        is still unknown, and requires the real total on the final chunk. That
        forces a one-chunk lookahead: a chunk cannot be sent as non-final until
        we know more data follows, and cannot be sent as final until we know
        none does. Two buffers alternate so the reader always has somewhere to
        write while a full chunk waits to be classified.

        Memory is therefore bounded at two chunks, not at the object size.
        """
        aligned = max(CHUNK_ALIGNMENT, (chunk_size // CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT)

        buffers = [bytearray(aligned), bytearray(aligned)]
        views = [memoryview(buffers[0]), memoryview(buffers[1])]
        current = 0
        filled = 0

        held: int | None = None  # index of a full buffer awaiting classification
        offset = 0  # bytes Drive has committed

        async def send(index: int, length: int, total: int | None) -> dict[str, Any] | None:
            """PUT one chunk. ``total`` set means this is the final chunk."""
            nonlocal offset
            if length == 0 and total is None:
                return None

            end = offset + length - 1
            marker = str(total) if total is not None else "*"
            # An empty object has no byte range at all.
            span = f"bytes */{total}" if length == 0 else f"bytes {offset}-{end}/{marker}"

            async def framed() -> AsyncIterator[bytes]:
                """Feed the chunk to httpx in small pieces.

                httpx accepts only bytes or an iterable of them, so the chunk
                cannot be handed over as a zero-copy view. Copying the whole
                8 MiB chunk instead makes peak memory climb with object size,
                because CPython does not reuse freed blocks that large.
                Slicing it keeps every allocation in the size class the
                allocator does reuse. Content-Length is explicit, or httpx
                falls back to chunked transfer-encoding.
                """
                for cursor in range(0, length, _UPLOAD_FRAME_SIZE):
                    stop = min(cursor + _UPLOAD_FRAME_SIZE, length)
                    yield bytes(views[index][cursor:stop])

            response = await self._http().put(
                upload_url,
                headers={"Content-Length": str(length), "Content-Range": span},
                content=framed(),
            )

            if response.status_code in (200, 201):
                offset += length
                if on_progress:
                    on_progress(
                        UploadProgress(
                            bytes_uploaded=offset, total_bytes=offset, percentage=100.0
                        )
                    )
                resource: dict[str, Any] = response.json()
                return resource

            if response.status_code != 308:
                raise self.map_error(response)

            # Trust the server's committed range over our own bookkeeping.
            committed = response.headers.get("range")
            offset = int(committed.split("-")[-1]) + 1 if committed else offset + length
            if on_progress:
                on_progress(UploadProgress(bytes_uploaded=offset))
            return None

        async for chunk in source:
            position = 0
            while position < len(chunk):
                take = min(aligned - filled, len(chunk) - position)
                buffers[current][filled : filled + take] = chunk[position : position + take]
                filled += take
                position += take

                if filled == aligned:
                    # A full buffer cannot be final while more data may follow,
                    # so release the previously held one and hold this instead.
                    if held is not None:
                        await send(held, aligned, None)
                    held = current
                    current = 1 - current
                    filled = 0

        # The stream is exhausted, so whatever remains is genuinely final.
        if held is not None and filled == 0:
            result = await send(held, aligned, offset + aligned)
        elif held is not None:
            await send(held, aligned, None)
            result = await send(current, filled, offset + filled)
        else:
            result = await send(current, filled, filled)

        if result is None:
            raise ProviderUnavailableError(
                "Google Drive accepted every chunk but never returned the file resource.",
                provider="google-drive",
            )
        return result

    async def stream_download(self, file_id: str) -> AsyncIterator[bytes]:
        """Stream a file's content without buffering it whole."""
        headers = await self._headers()
        async with self._http().stream(
            "GET", f"{API_BASE}/files/{file_id}", params={"alt": "media"}, headers=headers
        ) as response:
            if response.is_error:
                await response.aread()
                raise self.map_error(response)
            async for chunk in response.aiter_bytes():
                yield chunk
