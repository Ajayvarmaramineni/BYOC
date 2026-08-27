"""Google Drive provider adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

import httpx

from ...errors import InvalidInputError, ObjectNotFoundError
from ...paths import get_basename, normalize_virtual_path
from ...types import (
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadOptions,
)
from ._http import RESUMABLE_THRESHOLD, DriveHttpClient
from ._oauth import GoogleDriveScope, GoogleOAuthClient
from ._resolver import DrivePathResolver, LruTtlPathCache
from ._tokens import TokenSession, TokenStorage

PROVIDER_ID = "google-drive"

T = TypeVar("T")


class GoogleDriveProvider:
    """Store application files in the Drive account your user already owns.

    Uses the ``drive.file`` scope by default, so the app can only see files it
    created or that the user explicitly opened with it -- which keeps you out of
    Google's Restricted Scope security assessment.

    Args:
        client_id: OAuth client id.
        client_secret: Only for confidential server-side clients.
        redirect_uri: Redirect registered with the OAuth client.
        scopes: Defaults to ``[GoogleDriveScope.FILE]``.
        token_storage: Where the session persists between runs.
        session: An existing session, for pre-authenticated callers.
        root_folder_name: App folder created at the Drive root.
        cache: Optional path-cache override.
        client: An ``httpx.AsyncClient`` to reuse.
    """

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str | None = None,
        redirect_uri: str | None = None,
        scopes: list[str] | None = None,
        token_storage: TokenStorage | None = None,
        session: TokenSession | None = None,
        root_folder_name: str = "BYOC",
        cache: LruTtlPathCache | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not client_id:
            raise InvalidInputError(
                "GoogleDriveProvider requires a 'client_id'.", provider=PROVIDER_ID
            )

        self.oauth = GoogleOAuthClient(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            scopes=scopes or [GoogleDriveScope.FILE],
            token_storage=token_storage,
            session=session,
            client=client,
        )
        self.http = DriveHttpClient(self.oauth.get_access_token, client=client)
        self.resolver = DrivePathResolver(
            self.http, root_folder_name=root_folder_name, cache=cache
        )
        self.root_folder_name = root_folder_name

    # -- lifecycle ---------------------------------------------------------

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=PROVIDER_ID,
            name="Google Drive",
            category="personal-cloud",
            authentication="oauth2",
            supports_user_owned_storage=True,
            adapter_version="0.2.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            folders=True,
            sharing=True,
            public_urls=False,
            resumable_uploads=True,
            versioning=True,
            quota=True,
            server_side_copy=True,
        )

    async def connect(self) -> None:
        """Verify the session and ensure the app root folder exists."""
        await self.resolver.ensure_root_folder()

    async def disconnect(self) -> None:
        """Close HTTP resources. Does not revoke the token -- use ``oauth.revoke()``."""
        await self.http.aclose()
        await self.oauth.aclose()

    # -- operations --------------------------------------------------------

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Upload requires a file path.", provider=PROVIDER_ID)

        if isinstance(data, str):
            payload = data.encode("utf-8")
        elif isinstance(data, bytes | bytearray | memoryview):
            payload = bytes(data)
        else:
            raise InvalidInputError(
                "Google Drive upload requires bytes or str.", provider=PROVIDER_ID
            )

        mime = (options.mime_type if options else None) or "application/octet-stream"
        parent_id = await self.resolver.resolve_parent_folder_id(normalized, create=True)

        metadata = self.http.build_metadata(
            name=get_basename(normalized),
            parent_id=parent_id,
            virtual_path=normalized,
            mime_type=mime,
            extra=dict(options.metadata) if options else None,
        )

        resumable = options.resumable if options and options.resumable is not None else None
        wants_resumable = (
            resumable
            if resumable is not None
            else (len(payload) > RESUMABLE_THRESHOLD or bool(options and options.on_progress))
        )

        if wants_resumable:
            upload_url = await self.http.start_resumable_upload(metadata, mime)
            resource = await self.http.upload_chunks(
                upload_url,
                payload,
                chunk_size=(
                    options.chunk_size if options and options.chunk_size else 8 * 1024 * 1024
                ),
                on_progress=options.on_progress if options else None,
            )
        else:
            resource = await self.http.multipart_upload(metadata, payload, mime)

        obj = self.http.to_storage_object(resource, normalized)
        self.resolver.cache.set(normalized, obj.provider_id)
        return obj

    async def download(self, path: str) -> StorageOutput:
        normalized = normalize_virtual_path(path)

        async def fetch(file_id: str) -> tuple[dict[str, object], bytes]:
            return await self.http.get_file(file_id), await self.http.download_file(file_id)

        resource, body = await self._with_healing(normalized, fetch)

        async def stream() -> AsyncIterator[bytes]:
            yield body

        async def read() -> bytes:
            return body

        return StorageOutput(
            metadata=self.http.to_storage_object(resource, normalized), stream=stream, read=read
        )

    async def delete(self, path: str) -> None:
        normalized = normalize_virtual_path(path)
        try:
            await self._with_healing(normalized, self.http.delete_file)
        except ObjectNotFoundError:
            return  # Already gone: deletion is idempotent.
        finally:
            self.resolver.invalidate(normalized)

    async def metadata(self, path: str) -> StorageObject:
        normalized = normalize_virtual_path(path)
        resource = await self._with_healing(normalized, self.http.get_file)
        return self.http.to_storage_object(resource, normalized)

    async def exists(self, path: str) -> bool:
        try:
            await self.metadata(path)
        except ObjectNotFoundError:
            return False
        return True

    async def list(self, path: str | None = None) -> list[StorageObject]:
        normalized = normalize_virtual_path(path)
        parent_id = await self.resolver.resolve_folder_id(normalized, create=False)

        query = f"'{parent_id}' in parents and trashed = false"
        resources = await self.http.list_files(query, page_size=1000)

        results: list[StorageObject] = []
        for resource in resources:
            name = str(resource.get("name", ""))
            child_path = f"{normalized}/{name}" if normalized else name
            results.append(self.http.to_storage_object(resource, child_path))
        return results

    async def create_folder(self, path: str) -> StorageObject:
        normalized = normalize_virtual_path(path)
        if not normalized:
            raise InvalidInputError("Create folder requires a path.", provider=PROVIDER_ID)

        folder_id = await self.resolver.resolve_folder_id(normalized, create=True)
        return StorageObject(
            id=f"gdrive_{folder_id}",
            path=normalized,
            name=get_basename(normalized),
            provider=PROVIDER_ID,
            provider_id=folder_id,
            type="folder",
        )

    async def quota(self) -> StorageQuota:
        return await self.http.get_quota()

    # -- internals ---------------------------------------------------------

    async def _with_healing(
        self, normalized: str, operation: Callable[[str], Awaitable[T]]
    ) -> T:
        """Resolve a path and run ``operation`` on it, healing a stale cache.

        Users rename and delete files in the Drive web UI, so a cached id can go
        bad in two different ways: the path stops resolving, or it resolves to
        an id Drive has already deleted. Only the first is caught by retrying
        resolution alone, which is why the operation itself is inside the retry.
        A second failure is genuine and propagates.
        """
        try:
            return await operation(await self.resolver.resolve_file_id(normalized))
        except ObjectNotFoundError:
            self.resolver.invalidate(normalized)
            return await operation(await self.resolver.resolve_file_id(normalized))
