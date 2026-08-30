"""S3-compatible provider adapter.

Works against AWS S3, Cloudflare R2, MinIO, Wasabi, and any endpoint speaking
the S3 API. Bucket names, object keys, ETags and multipart uploads stay private
to this module -- BYOC core never sees them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any
from xml.etree import ElementTree

import httpx

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
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    UploadOptions,
)
from ._sigv4 import create_presigned_s3_url, sign_s3_request

PROVIDER_ID = "s3-compatible"
_S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_LIST_PAGE_GUARD = 10_000  # pages, not keys: stops a malformed server looping forever


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
            adapter_version="0.3.0",
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
        body: bytes | None = None,
    ) -> dict[str, str]:
        return sign_s3_request(
            access_key_id=self.access_key_id,
            secret_access_key=self.secret_access_key,
            region=self.region,
            method=method,
            url=url,
            headers=headers,
            body=body,
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

        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, bytes | bytearray | memoryview):
            payload = bytes(data)
        else:
            raise InvalidInputError(
                "S3 upload requires bytes or str. Streaming uploads are not yet supported.",
                provider=PROVIDER_ID,
            )

        mime = (options.mime_type if options else None) or "application/octet-stream"
        headers = {"content-type": mime}
        for meta_key, meta_value in (options.metadata if options else {}).items():
            headers[f"x-amz-meta-{meta_key.lower()}"] = meta_value

        async def send() -> StorageObject:
            signed = self._sign("PUT", url, headers, payload)
            response = await self._http().put(url, headers=signed, content=payload)
            if response.is_error:
                raise self._map_error(response, response.text)

            etag = response.headers.get("etag", "").strip('"') or None
            virtual = self._to_virtual_path(key)
            return StorageObject(
                id=f"s3_{self.bucket}_{key}",
                path=virtual,
                name=get_basename(virtual),
                provider=PROVIDER_ID,
                provider_id=key,
                type="file",
                size=len(payload),
                mime_type=mime,
                checksum=etag,
                metadata=dict(options.metadata) if options else {},
            )

        return await with_retry(send)

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
            root = ElementTree.fromstring(response.text)

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
