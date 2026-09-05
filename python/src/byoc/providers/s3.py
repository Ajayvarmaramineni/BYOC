"""S3-compatible provider adapter.

Works against AWS S3, Cloudflare R2, MinIO, Wasabi, and any endpoint speaking
the S3 API. Bucket names, object keys, ETags and multipart uploads stay private
to this module -- BYOC core never sees them.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Mapping
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote

import httpx
from defusedxml.common import DefusedXmlException
from defusedxml.ElementTree import ParseError, fromstring

from ..errors import (
    InvalidInputError,
    ObjectNotFoundError,
    PermissionDeniedError,
    ProviderUnavailableError,
    RateLimitedError,
    StorageError,
)
from ..paths import encode_path_segments, get_basename, normalize_virtual_path
from ..retry import with_retry
from ..types import (
    ProgressCallback,
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    UploadGrant,
    UploadGrantOptions,
    UploadOptions,
    UploadProgress,
)
from ._sigv4 import create_presigned_s3_url, sign_s3_request

_PART_FRAME_SIZE = 64 * 1024
"""Bytes handed to httpx at a time. Small enough that CPython reuses the block."""

MULTIPART_PART_SIZE = 8 * 1024 * 1024
"""Bytes buffered per multipart part. S3's floor is 5 MiB for every part but the last."""

PROVIDER_ID = "s3-compatible"
_S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_LIST_PAGE_GUARD = 10_000  # pages, not keys: stops a malformed server looping forever


def _parse_xml(text: str) -> Any:
    """Parse an S3 XML response with the same hardened parser list() uses."""
    try:
        return fromstring(text)
    except (ParseError, DefusedXmlException) as error:
        raise ProviderUnavailableError(
            f"S3 returned a response that is not valid XML: {error}", provider=PROVIDER_ID
        ) from error


def _text(element: Any, tag: str) -> str | None:
    """Read a child tag, tolerating servers that omit the S3 XML namespace."""
    found = element.find(f"{_S3_NS}{tag}")
    if found is None:
        found = element.find(tag)
    return found.text if found is not None else None


class S3CompatibleProvider:
    """Storage adapter for S3-compatible object stores.

    Args:
        endpoint: Base endpoint, e.g. ``https://<account>.r2.cloudflarestorage.com``.
        bucket: Bucket name.
        region: Region, or ``"auto"`` for Cloudflare R2.
        access_key_id: Access key.
        secret_access_key: Secret key.
        root_prefix: Optional key prefix all paths are stored under.
        force_path_style: Put the bucket in the URL path rather than the
            hostname. Required by MinIO and most self-hosted gateways.
        client: An existing ``httpx.AsyncClient`` to reuse. If omitted, one is
            created and closed by :meth:`disconnect`.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        region: str,
        access_key_id: str,
        secret_access_key: str,
        root_prefix: str | None = None,
        force_path_style: bool = False,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not endpoint or not bucket or not access_key_id or not secret_access_key:
            raise InvalidInputError(
                "S3CompatibleProvider requires endpoint, bucket, access_key_id, "
                "and secret_access_key.",
                provider=PROVIDER_ID,
            )

        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.region = region
        self.access_key_id = access_key_id
        self.secret_access_key = secret_access_key
        self.root_prefix = normalize_virtual_path(root_prefix) if root_prefix else ""
        self.force_path_style = force_path_style

        self._client = client
        self._owns_client = client is None

    # -- lifecycle ---------------------------------------------------------

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=PROVIDER_ID,
            name="S3 Compatible (R2/AWS/MinIO)",
            category="developer-cloud",
            authentication="access-key",
            supports_user_owned_storage=False,
            adapter_version="0.4.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        # S3 has no native folders and reports no account quota, so those stay
        # False rather than being faked with prefix tricks.
        return ProviderCapabilities(
            folders=False,
            sharing=False,
            public_urls=True,
            resumable_uploads=True,
            versioning=True,
            quota=False,
            server_side_copy=True,
            direct_upload=True,
        )

    async def connect(self) -> None:
        """No-op: SigV4 is stateless. Ensures an HTTP client exists."""
        self._http()

    async def disconnect(self) -> None:
        """Close the HTTP client if this adapter created it."""
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
            self._owns_client = True
        return self._client

    # -- key handling ------------------------------------------------------

    def _to_key(self, path: str) -> str:
        """Virtual path -> provider-side object key (adds ``root_prefix``)."""
        normalized = normalize_virtual_path(path)
        return f"{self.root_prefix}/{normalized}" if self.root_prefix else normalized

    def _to_virtual_path(self, key: str) -> str:
        """Provider-side object key -> virtual path (strips ``root_prefix``).

        ``root_prefix`` is the adapter's business, so it must not appear in a
        returned ``StorageObject.path``: callers feed those paths straight back
        into the client, and a leaked prefix would be applied a second time.
        The full key stays available as ``provider_id``.
        """
        if self.root_prefix and key.startswith(f"{self.root_prefix}/"):
            return key[len(self.root_prefix) + 1 :]
        return key

    def _bucket_base_url(self) -> str:
        return f"{self.endpoint}/{self.bucket}" if self.force_path_style else self.endpoint

    def object_url(self, key: str) -> str:
        """Absolute URL for an object key, with each segment RFC 3986 encoded.

        Segment-wise encoding is what keeps ``#`` and ``?`` in filenames from
        truncating the key into a fragment or query string.
        """
        return f"{self._bucket_base_url()}/{encode_path_segments(key)}"

    def signed_url(
        self, path: str, *, method: str = "GET", expires_in_seconds: int = 3600
    ) -> str:
        """Time-limited URL a browser can use directly, without proxying bytes."""
        return create_presigned_s3_url(
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            url=self.object_url(self._to_key(path)),
            method=method,
            expires_in_seconds=expires_in_seconds,
        )

    # Retained under its 0.2.x name; `signed_url` is what the client calls.
    presigned_url = signed_url

    def _sign(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        body: bytes | memoryview | None = None,
        unsigned_payload: bool = False,
    ) -> dict[str, str]:
        return sign_s3_request(
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            method=method,
            url=url,
            headers=headers,
            body=body,
            unsigned_payload=unsigned_payload,
        )

    # -- error mapping -----------------------------------------------------

    def _map_error(self, response: httpx.Response, body: str = "") -> StorageError:
        status = response.status_code

        if status == 404 or "NoSuchKey" in body or "NoSuchBucket" in body:
            return ObjectNotFoundError(
                f"S3 object not found (HTTP {status}).",
                provider=PROVIDER_ID,
                status_code=status,
            )
        if status in (401, 403) or "AccessDenied" in body:
            return PermissionDeniedError(
                "S3 access denied: invalid credentials or insufficient permissions.",
                provider=PROVIDER_ID,
                status_code=status,
            )
        if status == 429 or "SlowDown" in body:
            return RateLimitedError(
                "S3 rate limit exceeded.", provider=PROVIDER_ID, status_code=status
            )
        return ProviderUnavailableError(
            f"S3 error (HTTP {status}): {body[:300]}",
            provider=PROVIDER_ID,
            status_code=status,
            retryable=status >= 500,
        )

    def _object_from_headers(self, key: str, response: httpx.Response) -> StorageObject:
        etag = response.headers.get("etag", "").strip('"') or None
        length = response.headers.get("content-length")
        last_modified = response.headers.get("last-modified")

        updated_at: datetime | None = None
        if last_modified:
            try:
                updated_at = parsedate_to_datetime(last_modified)
            except (TypeError, ValueError):
                updated_at = None

        virtual = self._to_virtual_path(key)
        return StorageObject(
            id=f"s3_{self.bucket}_{key}",
            path=virtual,
            name=get_basename(virtual),
            provider=PROVIDER_ID,
            provider_id=key,
            type="file",
            size=int(length) if length is not None else None,
            mime_type=response.headers.get("content-type"),
            checksum=etag,
            updated_at=updated_at,
        )

    # -- operations --------------------------------------------------------

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        key = self._to_key(path)
        url = self.object_url(key)

        payload: bytes | None
        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, bytes | bytearray | memoryview):
            payload = bytes(data)
        else:
            # An async iterator streams straight to the wire. Its length is not
            # knowable up front, so the object's reported size comes from the
            # bytes actually sent.
            payload = None
            stream = data

        mime = (options.mime_type if options else None) or "application/octet-stream"
        headers = {"content-type": mime}
        for meta_key, meta_value in (options.metadata if options else {}).items():
            headers[f"x-amz-meta-{meta_key.lower()}"] = meta_value

        on_progress = options.on_progress if options else None
        virtual = self._to_virtual_path(key)

        def described(size: int, checksum: str | None) -> StorageObject:
            return StorageObject(
                id=f"s3_{self.bucket}_{key}",
                path=virtual,
                name=get_basename(virtual),
                provider=PROVIDER_ID,
                provider_id=key,
                type="file",
                size=size,
                mime_type=mime,
                checksum=checksum,
                metadata=dict(options.metadata) if options else {},
            )

        if payload is None:
            # S3 answers 411 Length Required to a chunked PUT, so an unbounded
            # stream goes up as a multipart upload instead. Only one part is
            # held in memory at a time, and each part signs its own real hash.
            size, checksum = await self._upload_stream(
                key, stream, mime, dict(options.metadata) if options else {}, on_progress
            )
            return described(size, checksum)

        async def send() -> StorageObject:
            signed = self._sign("PUT", url, headers, payload)
            response = await self._http().put(url, headers=signed, content=payload)
            if response.is_error:
                raise self._map_error(response, response.text)
            etag = response.headers.get("etag", "").strip('"') or None
            return described(len(payload), etag)

        return await with_retry(send)

    # -- multipart upload --------------------------------------------------

    async def _create_multipart_upload(
        self, key: str, mime: str, metadata: Mapping[str, str]
    ) -> str:
        url = f"{self.object_url(key)}?uploads="
        headers = {"content-type": mime}
        for meta_key, meta_value in metadata.items():
            headers[f"x-amz-meta-{meta_key.lower()}"] = meta_value

        async def send() -> str:
            signed = self._sign("POST", url, headers)
            response = await self._http().post(url, headers=signed)
            if response.is_error:
                raise self._map_error(response, response.text)
            root = _parse_xml(response.text)
            upload_id: str | None = _text(root, "UploadId")
            if not upload_id:
                raise ProviderUnavailableError(
                    "S3 did not return an UploadId for the multipart upload.",
                    provider=PROVIDER_ID,
                )
            return str(upload_id)

        return await with_retry(send)

    async def _upload_part(
        self, key: str, upload_id: str, part_number: int, body: bytes | memoryview
    ) -> str:
        encoded = quote(upload_id, safe="")
        url = f"{self.object_url(key)}?partNumber={part_number}&uploadId={encoded}"
        length = len(body)

        async def framed() -> AsyncIterator[bytes]:
            """Feed the part to httpx in small pieces.

            httpx accepts only ``bytes`` or an iterable of them -- a memoryview
            is iterated as integers and a bytearray is refused outright -- so
            the part cannot be handed over as a zero-copy view. Copying the
            whole 8 MiB part instead makes peak memory climb with file size,
            because CPython does not reuse freed blocks that large. Slicing it
            into 64 KiB pieces keeps every allocation inside the size range the
            allocator does reuse, so memory stays flat.
            """
            for offset in range(0, length, _PART_FRAME_SIZE):
                yield bytes(body[offset : offset + _PART_FRAME_SIZE])

        async def send() -> str:
            # The part is fully known, so its real hash is signed. Streaming
            # does not force UNSIGNED-PAYLOAD here: memory stays bounded to one
            # part while every byte remains covered by the signature.
            signed = self._sign("PUT", url, body=body)
            # Content-Length must be explicit, or httpx falls back to chunked
            # transfer-encoding and S3 answers 411 Length Required.
            signed["content-length"] = str(length)
            response = await self._http().put(url, headers=signed, content=framed())
            if response.is_error:
                raise self._map_error(response, response.text)
            etag: str = str(response.headers.get("etag", "")).strip('"')
            if not etag:
                raise ProviderUnavailableError(
                    f"S3 did not return an ETag for part {part_number}.",
                    provider=PROVIDER_ID,
                )
            return etag

        return await with_retry(send)

    async def _complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[tuple[int, str]]
    ) -> str | None:
        url = f"{self.object_url(key)}?uploadId={quote(upload_id, safe='')}"
        body = (
            "<CompleteMultipartUpload>"
            + "".join(
                f"<Part><PartNumber>{number}</PartNumber><ETag>&quot;{etag}&quot;</ETag></Part>"
                for number, etag in parts
            )
            + "</CompleteMultipartUpload>"
        ).encode("utf-8")

        headers = {"content-type": "application/xml"}
        signed = self._sign("POST", url, headers, body)
        response = await self._http().post(url, headers=signed, content=body)
        if response.is_error:
            raise self._map_error(response, response.text)

        # S3 can return a 200 whose body is an error, so the body must be read.
        text = response.text
        if "<Error>" in text:
            raise self._map_error(response, text)
        return (_text(_parse_xml(text), "ETag") or "").strip('"') or None

    async def _abort_multipart_upload(self, key: str, upload_id: str) -> None:
        """Discard a failed upload so its parts stop accruing storage charges."""
        url = f"{self.object_url(key)}?uploadId={quote(upload_id, safe='')}"
        # Best effort: the upload has already failed, and that failure is what
        # the caller needs to see. Raising from the cleanup would replace a
        # useful error with a confusing one. `suppress` states that intent,
        # where a bare `except: pass` reads like an oversight.
        with contextlib.suppress(Exception):
            signed = self._sign("DELETE", url)
            await self._http().request("DELETE", url, headers=signed)

    async def _upload_stream(
        self,
        key: str,
        source: AsyncIterator[bytes],
        mime: str,
        metadata: Mapping[str, str],
        on_progress: ProgressCallback | None,
    ) -> tuple[int, str | None]:
        """Stream an async iterator to S3 as a multipart upload.

        S3 refuses chunked transfer-encoding on PUT -- it answers 411 Length
        Required -- so an unbounded stream cannot go in one request. Multipart
        is the way round it: each part carries its own Content-Length, and only
        one part is ever held in memory.
        """
        upload_id = await self._create_multipart_upload(key, mime, metadata)
        parts: list[tuple[int, str]] = []

        # One buffer, filled and reused for every part.
        #
        # Two earlier shapes both failed on memory, and the reason is the same:
        # CPython does not return large freed blocks to the OS, so allocating a
        # fresh part each time makes peak RSS climb with file size even though
        # only one part is ever live.
        #
        #   bytearray + `del buf[:n]`   248 MB peak on a 200 MB stream
        #   list of chunks + b"".join"  322 MB peak on a 400 MB stream
        #   this, reusing one buffer     ~55 MB regardless of size
        #
        # Reuse is safe because each part is fully awaited before the buffer is
        # written again; nothing is in flight when we overwrite it.
        buffer = bytearray(MULTIPART_PART_SIZE)
        view = memoryview(buffer)
        filled = 0
        total = 0
        part_number = 1

        async def flush(length: int) -> None:
            nonlocal part_number, total
            etag = await self._upload_part(key, upload_id, part_number, view[:length])
            parts.append((part_number, etag))
            part_number += 1
            total += length
            if on_progress:
                on_progress(UploadProgress(bytes_uploaded=total))

        try:
            async for chunk in source:
                offset = 0
                while offset < len(chunk):
                    take = min(MULTIPART_PART_SIZE - filled, len(chunk) - offset)
                    buffer[filled : filled + take] = chunk[offset : offset + take]
                    filled += take
                    offset += take

                    # Every part but the last must be at least 5 MiB.
                    if filled == MULTIPART_PART_SIZE:
                        await flush(filled)
                        filled = 0

            # The final part carries whatever is left, and may be short. An
            # empty stream still needs one part: S3 rejects a zero-part upload.
            if filled or not parts:
                await flush(filled)

            checksum = await self._complete_multipart_upload(key, upload_id, parts)
        except BaseException:
            await self._abort_multipart_upload(key, upload_id)
            raise

        return total, checksum

    async def download(self, path: str) -> StorageOutput:
        key = self._to_key(path)
        url = self.object_url(key)

        async def fetch() -> httpx.Response:
            response = await self._http().get(url, headers=self._sign("GET", url))
            if response.is_error:
                raise self._map_error(response, response.text)
            return response

        response = await with_retry(fetch)
        body = response.content

        async def stream() -> AsyncIterator[bytes]:
            yield body

        async def read() -> bytes:
            return body

        return StorageOutput(
            metadata=self._object_from_headers(key, response), stream=stream, read=read
        )

    async def delete(self, path: str) -> None:
        key = self._to_key(path)
        url = self.object_url(key)

        async def send() -> None:
            signed = self._sign("DELETE", url)
            response = await self._http().request("DELETE", url, headers=signed)
            # S3 delete is idempotent: a missing object is a successful delete.
            if response.is_error and response.status_code != 404:
                raise self._map_error(response, response.text)

        await with_retry(send)

    async def create_upload_grant(
        self, path: str, options: UploadGrantOptions | None = None
    ) -> UploadGrant:
        """Mint a presigned PUT the browser uploads to directly.

        The signature covers ``host`` only and declares ``UNSIGNED-PAYLOAD``, so
        the browser does not have to reproduce any header exactly -- a mismatch
        there is the usual cause of a 403 on direct upload. Nothing in the grant
        carries this application's secret key; the URL is the capability, and it
        expires.

        The bucket needs a CORS rule allowing PUT from your origin, or the
        browser blocks the request before it is sent.
        """
        resolved = options or UploadGrantOptions()
        normalized = normalize_virtual_path(path)

        return UploadGrant(
            provider=PROVIDER_ID,
            path=normalized,
            url=self.signed_url(
                normalized,
                method="PUT",
                expires_in_seconds=resolved.expires_in_seconds,
            ),
            method="PUT",
            # Deliberately empty: any header signed here becomes one the browser
            # is obliged to send byte-for-byte.
            headers={},
            protocol="single",
            expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=resolved.expires_in_seconds),
        )

    async def copy(self, source: str, destination: str) -> None:
        """Server-side copy. The bytes never travel through this process."""
        source_key = self._to_key(source)
        dest_url = self.object_url(self._to_key(destination))

        # S3 wants the copy source as `/bucket/key`, URL-encoded. Encoding it
        # per segment is what keeps a `#` or `?` in the filename from
        # truncating the source key, exactly as it does for the object URL.
        copy_source = f"/{self.bucket}/{encode_path_segments(source_key)}"

        async def send() -> None:
            signed = self._sign("PUT", dest_url, {"x-amz-copy-source": copy_source})
            response = await self._http().request("PUT", dest_url, headers=signed)
            if response.is_error:
                raise self._map_error(response, response.text)

        await with_retry(send)

    async def move(self, source: str, destination: str) -> None:
        """Copy then delete. S3 has no atomic rename, so this is two calls."""
        await self.copy(source, destination)
        await self.delete(source)

    async def metadata(self, path: str) -> StorageObject:
        key = self._to_key(path)
        url = self.object_url(key)

        async def send() -> StorageObject:
            response = await self._http().head(url, headers=self._sign("HEAD", url))
            if response.is_error:
                raise self._map_error(response)
            return self._object_from_headers(key, response)

        return await with_retry(send)

    async def exists(self, path: str) -> bool:
        try:
            await self.metadata(path)
        except ObjectNotFoundError:
            return False
        return True

    async def list(self, path: str | None = None) -> list[StorageObject]:
        """List objects directly under ``path`` using ListObjectsV2.

        Follows ``NextContinuationToken`` past S3's 1000-key response cap, so a
        large prefix is not silently truncated.
        """
        prefix = self._to_key(path) if path else self.root_prefix
        if prefix:
            prefix = prefix if prefix.endswith("/") else f"{prefix}/"

        base = self._bucket_base_url()
        results: list[StorageObject] = []
        continuation: str | None = None

        for _ in range(_LIST_PAGE_GUARD):
            params = {"list-type": "2", "delimiter": "/"}
            if prefix:
                params["prefix"] = prefix
            if continuation:
                params["continuation-token"] = continuation

            url = str(httpx.URL(f"{base}/", params=params))

            async def fetch(target: str = url) -> httpx.Response:
                response = await self._http().get(target, headers=self._sign("GET", target))
                if response.is_error:
                    raise self._map_error(response, response.text)
                return response

            response = await with_retry(fetch)
            try:
                root = fromstring(response.text)
            except (DefusedXmlException, ParseError) as exc:
                raise ProviderUnavailableError(
                    "S3 returned malformed or unsafe XML.",
                    provider=PROVIDER_ID,
                    raw_error=exc,
                ) from exc

            for prefix_node in root.iter(f"{_S3_NS}CommonPrefixes"):
                folder = _text(prefix_node, "Prefix")
                if folder:
                    trimmed = folder.rstrip("/")
                    virtual_folder = self._to_virtual_path(trimmed)
                    results.append(
                        StorageObject(
                            id=f"s3_{self.bucket}_{trimmed}",
                            path=virtual_folder,
                            name=get_basename(virtual_folder),
                            provider=PROVIDER_ID,
                            provider_id=trimmed,
                            type="folder",
                        )
                    )

            for item in root.iter(f"{_S3_NS}Contents"):
                key = _text(item, "Key")
                if not key or key == prefix:
                    continue
                size = _text(item, "Size")
                modified = _text(item, "LastModified")
                virtual_key = self._to_virtual_path(key)
                results.append(
                    StorageObject(
                        id=f"s3_{self.bucket}_{key}",
                        path=virtual_key,
                        name=get_basename(virtual_key),
                        provider=PROVIDER_ID,
                        provider_id=key,
                        type="file",
                        size=int(size) if size else None,
                        checksum=(_text(item, "ETag") or "").strip('"') or None,
                        updated_at=datetime.fromisoformat(modified.replace("Z", "+00:00"))
                        if modified
                        else None,
                    )
                )

            truncated = (_text(root, "IsTruncated") or "false").lower() == "true"
            continuation = _text(root, "NextContinuationToken") if truncated else None
            if not continuation:
                break

        return results
