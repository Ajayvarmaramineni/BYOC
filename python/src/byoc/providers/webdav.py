"""WebDAV provider adapter.

Targets Nextcloud, ownCloud, Synology NAS, and any RFC 4918 server. WebDAV
collections, multistatus XML, and HTTP method verbs stay private to this module.

Unlike S3, WebDAV has real folders, so an upload creates missing ancestors with
MKCOL before writing.
"""

from __future__ import annotations

import base64
import contextlib
from collections.abc import AsyncIterator
from datetime import datetime
from email.utils import parsedate_to_datetime
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

import httpx

from ..errors import (
    ConflictError,
    InvalidInputError,
    ObjectNotFoundError,
    PermissionDeniedError,
    ProviderUnavailableError,
    RateLimitedError,
    StorageError,
)
from ..paths import encode_path_segments, get_basename, get_dirname, normalize_virtual_path
from ..retry import with_retry
from ..types import (
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadOptions,
)

PROVIDER_ID = "webdav"
_DAV = "{DAV:}"

_PROPFIND_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
  </d:prop>
</d:propfind>"""

_QUOTA_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:quota-available-bytes/>
    <d:quota-used-bytes/>
  </d:prop>
</d:propfind>"""


def _prop(response_el: ElementTree.Element, tag: str) -> str | None:
    """Read a DAV property from a multistatus <response> element."""
    for propstat in response_el.findall(f"{_DAV}propstat"):
        status = propstat.findtext(f"{_DAV}status") or ""
        if "200" not in status:
            continue
        found = propstat.find(f"{_DAV}prop/{_DAV}{tag}")
        if found is not None and found.text is not None:
            return found.text
    return None


def _is_collection(response_el: ElementTree.Element) -> bool:
    for propstat in response_el.findall(f"{_DAV}propstat"):
        resource_type = propstat.find(f"{_DAV}prop/{_DAV}resourcetype")
        if resource_type is not None and resource_type.find(f"{_DAV}collection") is not None:
            return True
    return False


class WebDAVProvider:
    """Storage adapter for WebDAV servers.

    Args:
        endpoint: Collection URL, e.g.
            ``https://cloud.example.com/remote.php/dav/files/alex/``.
        username: Username for Basic auth.
        password: Password for Basic auth. Use an app password, not the account
            password -- app passwords are scoped and independently revocable.
        token: Bearer token, as an alternative to username/password.
        root_folder: Folder inside the endpoint that all paths live under.
        client: An existing ``httpx.AsyncClient`` to reuse.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        username: str | None = None,
        password: str | None = None,
        token: str | None = None,
        root_folder: str | None = "BYOC",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not endpoint:
            raise InvalidInputError(
                "WebDAVProvider requires an 'endpoint' URL.", provider=PROVIDER_ID
            )

        self.endpoint = endpoint.rstrip("/")
        self.username = username
        self.password = password
        self.token = token
        self.root_folder = normalize_virtual_path(root_folder) if root_folder else ""

        self._base_path = urlsplit(self.endpoint).path.rstrip("/")
        self._client = client
        self._owns_client = client is None

    # -- lifecycle ---------------------------------------------------------

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=PROVIDER_ID,
            name="Nextcloud / WebDAV",
            category="self-hosted",
            authentication="oauth2" if self.token else "basic",
            supports_user_owned_storage=True,
            adapter_version="0.2.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        # WebDAV has real collections and RFC 4331 quota, but no resumable
        # upload protocol: large files go as a single PUT.
        return ProviderCapabilities(
            folders=True,
            sharing=False,
            public_urls=False,
            resumable_uploads=False,
            versioning=False,
            quota=True,
            server_side_copy=True,
        )

    async def connect(self) -> None:
        """Ensure the root folder exists, tolerating one that already does."""
        if self.root_folder:
            with contextlib.suppress(StorageError):
                await self._mkcol(self.root_folder)

    async def disconnect(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
            self._owns_client = True
        return self._client

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = dict(extra or {})
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        elif self.username is not None and self.password is not None:
            raw = f"{self.username}:{self.password}".encode()
            headers["Authorization"] = f"Basic {base64.b64encode(raw).decode('ascii')}"
        return headers

    # -- path handling -----------------------------------------------------

    def _to_remote(self, path: str) -> str:
        """Virtual path -> path relative to the endpoint (adds ``root_folder``)."""
        normalized = normalize_virtual_path(path)
        if not self.root_folder:
            return normalized
        return f"{self.root_folder}/{normalized}" if normalized else self.root_folder

    def _to_virtual_path(self, remote: str) -> str:
        """Endpoint-relative path -> virtual path (strips ``root_folder``).

        ``root_folder`` is the adapter's business and must not appear in a
        returned ``StorageObject.path``, or a caller feeding that path back in
        would have the folder applied twice.
        """
        if self.root_folder and remote.startswith(f"{self.root_folder}/"):
            return remote[len(self.root_folder) + 1 :]
        if remote == self.root_folder:
            return ""
        return remote

    def _url(self, remote_path: str) -> str:
        encoded = encode_path_segments(remote_path)
        return f"{self.endpoint}/{encoded}" if encoded else self.endpoint

    def _href_to_remote(self, href: str) -> str:
        """Turn a multistatus href into an endpoint-relative path.

        Servers return hrefs either absolute or path-only, always percent-encoded.
        """
        path = unquote(urlsplit(href).path)
        if self._base_path and path.startswith(self._base_path):
            path = path[len(self._base_path) :]
        return path.strip("/")

    # -- error mapping -----------------------------------------------------

    def _map_error(self, response: httpx.Response) -> StorageError:
        status = response.status_code
        if status == 404:
            return ObjectNotFoundError(
                "WebDAV resource not found (HTTP 404).", provider=PROVIDER_ID, status_code=404
            )
        if status in (401, 403):
            return PermissionDeniedError(
                "WebDAV access denied: check credentials or use an app password.",
                provider=PROVIDER_ID,
                status_code=status,
            )
        if status in (405, 409, 412):
            return ConflictError(
                f"WebDAV conflict (HTTP {status}): the parent collection may not exist.",
                provider=PROVIDER_ID,
                status_code=status,
            )
        if status == 429:
            return RateLimitedError(
                "WebDAV rate limit exceeded.", provider=PROVIDER_ID, status_code=status
            )
        return ProviderUnavailableError(
            f"WebDAV error (HTTP {status}): {response.text[:300]}",
            provider=PROVIDER_ID,
            status_code=status,
            retryable=status >= 500,
        )

    def _object_from_response(self, remote: str, response: httpx.Response) -> StorageObject:
        virtual = self._to_virtual_path(remote)
        length = response.headers.get("content-length")
        last_modified = response.headers.get("last-modified")

        updated_at: datetime | None = None
        if last_modified:
            try:
                updated_at = parsedate_to_datetime(last_modified)
            except (TypeError, ValueError):
                updated_at = None

        return StorageObject(
            id=f"webdav_{remote}",
            path=virtual,
            name=get_basename(virtual) or get_basename(remote),
            provider=PROVIDER_ID,
            provider_id=remote,
            type="file",
            size=int(length) if length is not None else None,
            mime_type=response.headers.get("content-type"),
            checksum=(response.headers.get("etag") or "").strip('"') or None,
            updated_at=updated_at,
        )

    def _object_from_propfind(
        self, remote: str, entry: ElementTree.Element
    ) -> StorageObject:
        """Build a StorageObject from one multistatus <response> element."""
        is_folder = _is_collection(entry)
        size = _prop(entry, "getcontentlength")
        modified = _prop(entry, "getlastmodified")

        updated_at: datetime | None = None
        if modified:
            try:
                updated_at = parsedate_to_datetime(modified)
            except (TypeError, ValueError):
                updated_at = None

        virtual = self._to_virtual_path(remote)
        return StorageObject(
            id=f"webdav_{remote}",
            path=virtual,
            name=get_basename(virtual) or get_basename(remote),
            provider=PROVIDER_ID,
            provider_id=remote,
            type="folder" if is_folder else "file",
            size=int(size) if size and not is_folder else None,
            mime_type=_prop(entry, "getcontenttype"),
            checksum=(_prop(entry, "getetag") or "").strip('"') or None,
            updated_at=updated_at,
        )

    # -- WebDAV verbs ------------------------------------------------------

    async def _mkcol(self, remote: str) -> None:
        url = self._url(remote)
        response = await self._http().request("MKCOL", url, headers=self._headers())
        # 405 means the collection already exists, which is the desired state.
        if response.is_error and response.status_code != 405:
            raise self._map_error(response)

    async def _ensure_parents(self, remote_dir: str) -> None:
        """Create each missing ancestor collection, outermost first."""
        if not remote_dir:
            return
        segments = remote_dir.split("/")
        for index in range(1, len(segments) + 1):
            try:
                await self._mkcol("/".join(segments[:index]))
            except StorageError:
                # A parent that already exists is fine; a real failure surfaces
                # on the PUT that follows.
                continue

    # -- operations --------------------------------------------------------

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        remote = self._to_remote(path)
        await self._ensure_parents(get_dirname(remote))

        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, bytes | bytearray | memoryview):
            payload = bytes(data)
        else:
            raise InvalidInputError(
                "WebDAV upload requires bytes or str. Streaming uploads are not yet supported.",
                provider=PROVIDER_ID,
            )

        mime = (options.mime_type if options else None) or "application/octet-stream"
        url = self._url(remote)

        async def send() -> StorageObject:
            response = await self._http().put(
                url, headers=self._headers({"content-type": mime}), content=payload
            )
            if response.is_error:
                raise self._map_error(response)

            return StorageObject(
                id=f"webdav_{remote}",
                path=self._to_virtual_path(remote),
                name=get_basename(remote),
                provider=PROVIDER_ID,
                provider_id=remote,
                type="file",
                size=len(payload),
                mime_type=mime,
                checksum=(response.headers.get("etag") or "").strip('"') or None,
            )

        return await with_retry(send)

    async def download(self, path: str) -> StorageOutput:
        remote = self._to_remote(path)
        url = self._url(remote)

        async def fetch() -> httpx.Response:
            response = await self._http().get(url, headers=self._headers())
            if response.is_error:
                raise self._map_error(response)
            return response

        response = await with_retry(fetch)
        body = response.content

        async def stream() -> AsyncIterator[bytes]:
            yield body

        async def read() -> bytes:
            return body

        return StorageOutput(
            metadata=self._object_from_response(remote, response), stream=stream, read=read
        )

    async def delete(self, path: str) -> None:
        remote = self._to_remote(path)
        url = self._url(remote)

        async def send() -> None:
            response = await self._http().request("DELETE", url, headers=self._headers())
            if response.is_error and response.status_code != 404:
                raise self._map_error(response)

        await with_retry(send)

    async def metadata(self, path: str) -> StorageObject:
        """Read properties with ``PROPFIND`` at ``Depth: 0``.

        PROPFIND rather than HEAD: it is the canonical WebDAV way to read
        properties, returns size/type/etag/mtime uniformly across servers, and
        avoids a real interop hazard -- some servers attach an HTML error body
        to a HEAD 404, which desynchronizes a keep-alive connection and makes
        the *next* request on it fail with a bogus parse error.
        """
        remote = self._to_remote(path)
        url = self._url(remote)

        async def send() -> StorageObject:
            response = await self._http().request(
                "PROPFIND",
                url,
                headers=self._headers({"Depth": "0", "content-type": "application/xml"}),
                content=_PROPFIND_BODY.encode("utf-8"),
            )
            if response.is_error:
                raise self._map_error(response)

            root = ElementTree.fromstring(response.text)
            entry = root.find(f"{_DAV}response")
            if entry is None:
                raise ObjectNotFoundError(
                    f"WebDAV resource not found: {path}", provider=PROVIDER_ID, status_code=404
                )

            return self._object_from_propfind(remote, entry)

        return await with_retry(send)

    async def exists(self, path: str) -> bool:
        try:
            await self.metadata(path)
        except ObjectNotFoundError:
            return False
        return True

    async def list(self, path: str | None = None) -> list[StorageObject]:
        """List one level below ``path`` via PROPFIND with ``Depth: 1``."""
        remote = self._to_remote(path or "")
        url = self._url(remote)

        async def fetch() -> httpx.Response:
            response = await self._http().request(
                "PROPFIND",
                url,
                headers=self._headers({"Depth": "1", "content-type": "application/xml"}),
                content=_PROPFIND_BODY.encode("utf-8"),
            )
            if response.is_error:
                raise self._map_error(response)
            return response

        response = await with_retry(fetch)
        root = ElementTree.fromstring(response.text)
        results: list[StorageObject] = []

        for entry in root.findall(f"{_DAV}response"):
            href = entry.findtext(f"{_DAV}href") or ""
            entry_remote = self._href_to_remote(href)

            # PROPFIND includes the collection itself; only children are listed.
            if entry_remote == remote or not entry_remote:
                continue

            results.append(self._object_from_propfind(entry_remote, entry))

        return results

    async def create_folder(self, path: str) -> StorageObject:
        remote = self._to_remote(path)
        await self._ensure_parents(remote)
        return StorageObject(
            id=f"webdav_{remote}",
            path=self._to_virtual_path(remote),
            name=get_basename(remote),
            provider=PROVIDER_ID,
            provider_id=remote,
            type="folder",
        )

    async def move(self, source: str, destination: str) -> None:
        """Server-side move (RFC 4918 MOVE), no bytes transferred."""
        target = self._to_remote(destination)
        await self._ensure_parents(get_dirname(target))
        response = await self._http().request(
            "MOVE",
            self._url(self._to_remote(source)),
            headers=self._headers({"Destination": self._url(target), "Overwrite": "T"}),
        )
        if response.is_error:
            raise self._map_error(response)

    async def copy(self, source: str, destination: str) -> None:
        """Server-side copy (RFC 4918 COPY), no bytes transferred."""
        target = self._to_remote(destination)
        await self._ensure_parents(get_dirname(target))
        response = await self._http().request(
            "COPY",
            self._url(self._to_remote(source)),
            headers=self._headers({"Destination": self._url(target), "Overwrite": "T"}),
        )
        if response.is_error:
            raise self._map_error(response)

    async def quota(self) -> StorageQuota:
        """Report quota via RFC 4331 properties, where the server supplies them."""
        response = await self._http().request(
            "PROPFIND",
            self._url(self._to_remote("")),
            headers=self._headers({"Depth": "0", "content-type": "application/xml"}),
            content=_QUOTA_BODY.encode("utf-8"),
        )
        if response.is_error:
            raise self._map_error(response)

        root = ElementTree.fromstring(response.text)
        entry = root.find(f"{_DAV}response")
        if entry is None:
            return StorageQuota(used=0)

        used_text = _prop(entry, "quota-used-bytes")
        available_text = _prop(entry, "quota-available-bytes")

        used = int(used_text) if used_text and used_text.lstrip("-").isdigit() else 0
        available: int | None = None
        if available_text and available_text.lstrip("-").isdigit():
            candidate = int(available_text)
            # Negative values are RFC 4331 sentinels for "unlimited"/"unknown".
            available = candidate if candidate >= 0 else None

        total = used + available if available is not None else None
        return StorageQuota(used=used, total=total, available=available)
