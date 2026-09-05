"""Google Drive adapter tests over a mock HTTP transport.

Drive cannot be exercised in CI -- it needs a real Google account and a browser
consent step -- so these cover as much of the wire behaviour as possible without
one: query escaping, the appProperties contract, OAuth refresh, resumable
chunking, error mapping, and cache self-healing.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from byoc.errors import (
    AuthRequiredError,
    ObjectNotFoundError,
    QuotaExceededError,
    RateLimitedError,
    TokenExpiredError,
)
from byoc.providers.gdrive import (
    VIRTUAL_PATH_PROPERTY,
    EncryptedFileTokenStorage,
    GoogleDriveProvider,
    GoogleDriveScope,
    GoogleOAuthClient,
    InMemoryTokenStorage,
    LruTtlPathCache,
    TokenSession,
    escape_drive_query_value,
)

FOLDER_MIME = "application/vnd.google-apps.folder"


# -- query escaping ----------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "escaped"),
    [
        ("simple.txt", "simple.txt"),
        ("Bob's Notes.pdf", "Bob\\'s Notes.pdf"),
        ("back\\slash.txt", "back\\\\slash.txt"),
        ("both'and\\.txt", "both\\'and\\\\.txt"),
        ("x' or name != '", "x\\' or name != \\'"),
    ],
)
def test_drive_query_escaping(raw: str, escaped: str) -> None:
    """An unescaped quote breaks the query, or injects extra clauses into it."""
    assert escape_drive_query_value(raw) == escaped


def test_backslashes_are_escaped_before_quotes() -> None:
    """Wrong order double-escapes the backslash added for the quote."""
    assert escape_drive_query_value("a\\'b") == "a\\\\\\'b"


# -- path cache --------------------------------------------------------------


def test_cache_expires_entries() -> None:
    cache = LruTtlPathCache(ttl_seconds=0.0)
    cache.set("a/b.txt", "id-1")
    assert cache.get("a/b.txt") is None


def test_cache_evicts_least_recently_used() -> None:
    cache = LruTtlPathCache(max_entries=2)
    cache.set("a", "1")
    cache.set("b", "2")
    cache.get("a")  # make "b" the least recently used
    cache.set("c", "3")

    assert cache.get("a") == "1"
    assert cache.get("b") is None
    assert cache.get("c") == "3"


def test_invalidate_drops_descendants() -> None:
    """A moved folder makes every cached path beneath it suspect."""
    cache = LruTtlPathCache()
    cache.set("a", "1")
    cache.set("a/b", "2")
    cache.set("a/b/c.txt", "3")
    cache.set("other", "4")

    cache.invalidate("a")

    assert cache.get("a") is None
    assert cache.get("a/b") is None
    assert cache.get("a/b/c.txt") is None
    assert cache.get("other") == "4"


# -- OAuth -------------------------------------------------------------------


def test_authorization_url_contains_pkce_and_offline_access() -> None:
    oauth = GoogleOAuthClient(client_id="cid", redirect_uri="https://app.example/cb")
    url = oauth.get_authorization_url(state="st8", code_challenge="chal")
    params = parse_qs(urlparse(url).query)

    assert params["client_id"] == ["cid"]
    assert params["code_challenge"] == ["chal"]
    assert params["code_challenge_method"] == ["S256"]
    assert params["state"] == ["st8"]
    # Without offline+consent Google never returns a refresh token.
    assert params["access_type"] == ["offline"]
    assert params["prompt"] == ["consent"]
    assert params["scope"] == [GoogleDriveScope.FILE]


def test_authorization_url_requires_a_redirect_uri() -> None:
    from byoc.errors import InvalidInputError

    oauth = GoogleOAuthClient(client_id="cid")
    with pytest.raises(InvalidInputError):
        oauth.get_authorization_url()


async def test_exchange_code_stores_the_session() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["form"] = parse_qs(request.content.decode())
        return httpx.Response(
            200,
            json={
                "access_token": "at-1",
                "refresh_token": "rt-1",
                "expires_in": 3599,
                "token_type": "Bearer",
                "scope": GoogleDriveScope.FILE,
            },
        )

    storage = InMemoryTokenStorage()
    oauth = GoogleOAuthClient(
        client_id="cid",
        redirect_uri="https://app.example/cb",
        token_storage=storage,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    session = await oauth.exchange_code(code="auth-code", code_verifier="verifier")

    assert captured["form"]["code_verifier"] == ["verifier"]
    assert captured["form"]["grant_type"] == ["authorization_code"]
    assert session.access_token == "at-1"
    assert storage.get() is not None


async def test_refresh_preserves_the_refresh_token() -> None:
    """Google omits refresh_token on refresh; dropping it would end the session."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "at-2", "expires_in": 3599})

    storage = InMemoryTokenStorage(
        TokenSession(access_token="old", refresh_token="rt-keep", expires_at=time.time() - 10)
    )
    oauth = GoogleOAuthClient(
        client_id="cid",
        token_storage=storage,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    token = await oauth.get_access_token()
    assert token == "at-2"

    stored = storage.get()
    assert stored is not None
    assert stored.refresh_token == "rt-keep"


async def test_expired_session_without_refresh_token_raises() -> None:
    oauth = GoogleOAuthClient(
        client_id="cid",
        token_storage=InMemoryTokenStorage(
            TokenSession(access_token="old", expires_at=time.time() - 10)
        ),
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))),
    )
    with pytest.raises(AuthRequiredError):
        await oauth.get_access_token()


async def test_invalid_grant_maps_to_token_expired() -> None:
    """A dead refresh token needs re-consent, not a retry."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant", "error_description": "expired"})

    oauth = GoogleOAuthClient(
        client_id="cid",
        token_storage=InMemoryTokenStorage(
            TokenSession(access_token="a", refresh_token="dead", expires_at=time.time() - 10)
        ),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(TokenExpiredError):
        await oauth.get_access_token()


async def test_revoke_clears_storage_even_when_the_call_fails() -> None:
    """A revoked token must never linger locally."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    storage = InMemoryTokenStorage(TokenSession(access_token="a", refresh_token="r"))
    oauth = GoogleOAuthClient(
        client_id="cid",
        token_storage=storage,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await oauth.revoke()
    assert storage.get() is None


# -- token storage -----------------------------------------------------------


def test_encrypted_file_storage_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "session.enc"
    storage = EncryptedFileTokenStorage(target, "a-strong-encryption-key")

    storage.set(TokenSession(access_token="at", refresh_token="rt", expires_at=123.0))
    loaded = storage.get()

    assert loaded is not None
    assert loaded.refresh_token == "rt"
    # The refresh token must not be readable on disk.
    assert b"rt" not in target.read_bytes()
    assert target.read_bytes()[:12] == b"BYOC_E2EE_V3"


def test_encrypted_file_storage_is_owner_only(tmp_path: Path) -> None:
    target = tmp_path / "session.enc"
    EncryptedFileTokenStorage(target, "key").set(TokenSession(access_token="at"))
    assert oct(target.stat().st_mode)[-3:] == "600"


def test_encrypted_file_storage_survives_a_wrong_key(tmp_path: Path) -> None:
    """A foreign or corrupt file means 're-authenticate', not a crash."""
    target = tmp_path / "session.enc"
    EncryptedFileTokenStorage(target, "key-a").set(TokenSession(access_token="at"))
    assert EncryptedFileTokenStorage(target, "key-b").get() is None


def test_session_expiry_uses_a_safety_margin() -> None:
    """A token expiring in 10s is treated as expired, not used and lost mid-call."""
    assert TokenSession(access_token="a", expires_at=time.time() + 10).is_expired is True
    assert TokenSession(access_token="a", expires_at=time.time() + 600).is_expired is False
    assert TokenSession(access_token="a").is_expired is False


# -- adapter -----------------------------------------------------------------


class FakeDrive:
    """A small in-memory stand-in for the Drive API."""

    def __init__(self) -> None:
        self.files: dict[str, dict[str, Any]] = {}
        self.content: dict[str, bytes] = {}
        self.queries: list[str] = []
        self._next_id = 0
        self.root_id = self._add("BYOC", FOLDER_MIME, "root")

    def _add(self, name: str, mime: str, parent: str, **extra: Any) -> str:
        self._next_id += 1
        file_id = f"id-{self._next_id}"
        self.files[file_id] = {"id": file_id, "name": name, "mimeType": mime,
                               "parents": [parent], "trashed": False, **extra}
        return file_id

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)

        if "oauth2.googleapis.com" in url:
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3599})

        if request.method == "GET" and "/files" in url and "alt=media" in url:
            file_id = url.split("/files/")[1].split("?")[0]
            return httpx.Response(200, content=self.content.get(file_id, b""))

        if (request.method == "GET" and url.rstrip("/").endswith("/about")) or "/about?" in url:
            return httpx.Response(
                200, json={"storageQuota": {"usage": "1024", "limit": "15000000000"}}
            )

        if request.method == "GET" and "/files?" in url:
            query = parse_qs(urlparse(url).query).get("q", [""])[0]
            self.queries.append(query)
            return httpx.Response(200, json={"files": self._match(query)})

        if request.method == "GET" and "/files/" in url:
            file_id = url.split("/files/")[1].split("?")[0]
            if file_id not in self.files:
                return httpx.Response(404, json={"error": {"message": "Not found"}})
            return httpx.Response(200, json=self.files[file_id])

        if request.method == "POST" and "upload/drive" in url:
            body = request.content
            parts = body.split(b"\r\n\r\n")
            meta = json.loads(parts[1].split(b"\r\n--")[0])
            content = parts[2].rsplit(b"\r\n--", 1)[0] if len(parts) > 2 else b""
            file_id = self._add(
                meta["name"], meta.get("mimeType", ""), meta["parents"][0],
                appProperties=meta.get("appProperties", {}), size=str(len(content)),
            )
            self.content[file_id] = content
            return httpx.Response(200, json=self.files[file_id])

        if request.method == "POST" and "/files" in url:
            meta = json.loads(request.content)
            file_id = self._add(meta["name"], meta["mimeType"], meta["parents"][0])
            return httpx.Response(200, json={"id": file_id})

        if request.method == "DELETE":
            file_id = url.split("/files/")[1].split("?")[0]
            self.files.pop(file_id, None)
            return httpx.Response(204)

        return httpx.Response(404, json={"error": {"message": f"unhandled {request.method} {url}"}})

    def _match(self, query: str) -> list[dict[str, Any]]:
        results = []
        for record in self.files.values():
            if record["trashed"]:
                continue
            name = record["name"].replace("\\", "\\\\").replace("'", "\\'")
            if f"name = '{name}'" not in query:
                continue
            parent = record["parents"][0]
            if f"'{parent}' in parents" not in query:
                continue
            if FOLDER_MIME in query and record["mimeType"] != FOLDER_MIME:
                continue
            results.append(record)
        return results


def _provider(drive: FakeDrive, **kwargs: Any) -> GoogleDriveProvider:
    return GoogleDriveProvider(
        client_id="cid",
        session=TokenSession(access_token="at", refresh_token="rt", expires_at=time.time() + 3600),
        client=httpx.AsyncClient(transport=httpx.MockTransport(drive.handler)),
        **kwargs,
    )


def test_manifest_and_capabilities() -> None:
    provider = _provider(FakeDrive())
    assert provider.manifest().id == "google-drive"
    assert provider.manifest().category == "personal-cloud"
    caps = provider.capabilities()
    assert caps.folders is True
    assert caps.quota is True
    assert caps.resumable_uploads is True


async def test_upload_writes_the_shared_virtual_path_property() -> None:
    """byocVirtualPath is wire format: the TypeScript SDK reads this exact key."""
    drive = FakeDrive()
    provider = _provider(drive)

    obj = await provider.upload("docs/report.pdf", b"PDF", None)

    record = drive.files[obj.provider_id]
    assert record["appProperties"][VIRTUAL_PATH_PROPERTY] == "docs/report.pdf"
    assert obj.path == "docs/report.pdf"
    assert obj.name == "report.pdf"


async def test_upload_creates_nested_folders() -> None:
    drive = FakeDrive()
    provider = _provider(drive)
    await provider.upload("a/b/c/deep.txt", b"x", None)

    folder_names = [f["name"] for f in drive.files.values() if f["mimeType"] == FOLDER_MIME]
    assert {"BYOC", "a", "b", "c"} <= set(folder_names)


async def test_apostrophe_filenames_are_escaped_in_queries() -> None:
    """The bug that once made every apostrophe filename a 400."""
    drive = FakeDrive()
    provider = _provider(drive)

    await provider.upload("notes/Bob's Notes.pdf", b"x", None)
    # Clear the cache so the lookup actually reaches Drive.
    provider.resolver.cache.clear()
    assert await provider.exists("notes/Bob's Notes.pdf") is True
    assert any("Bob\\'s Notes.pdf" in q for q in drive.queries)


async def test_download_roundtrip() -> None:
    drive = FakeDrive()
    provider = _provider(drive)
    await provider.upload("docs/note.txt", b"hello drive", None)

    out = await provider.download("docs/note.txt")
    assert await out.read() == b"hello drive"


async def test_missing_file_raises_not_found() -> None:
    provider = _provider(FakeDrive())
    with pytest.raises(ObjectNotFoundError):
        await provider.metadata("docs/absent.txt")


async def test_delete_is_idempotent() -> None:
    drive = FakeDrive()
    provider = _provider(drive)
    await provider.upload("temp.txt", b"x", None)

    await provider.delete("temp.txt")
    assert await provider.exists("temp.txt") is False
    await provider.delete("temp.txt")  # must not raise


async def test_self_heals_after_an_out_of_band_delete() -> None:
    """A user deleting a file in the Drive UI leaves a stale cached id behind."""
    drive = FakeDrive()
    provider = _provider(drive)
    obj = await provider.upload("docs/a.txt", b"x", None)

    # Simulate the web UI: the file vanishes, but our cache still points at it.
    del drive.files[obj.provider_id]
    assert provider.resolver.cache.get("docs/a.txt") is not None

    assert await provider.exists("docs/a.txt") is False
    assert provider.resolver.cache.get("docs/a.txt") is None


async def test_quota_is_reported() -> None:
    provider = _provider(FakeDrive())
    quota = await provider.quota()
    assert quota.used == 1024
    assert quota.total == 15_000_000_000
    assert quota.available == 15_000_000_000 - 1024


# -- error mapping -----------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "reason", "expected"),
    [
        (403, "storageQuotaExceeded", QuotaExceededError),
        (403, "rateLimitExceeded", RateLimitedError),
        (429, "", RateLimitedError),
        (401, "", AuthRequiredError),
        (404, "", ObjectNotFoundError),
    ],
)
def test_drive_error_mapping(status: int, reason: str, expected: type) -> None:
    """403 is overloaded by Drive: quota and rate limits hide behind it."""
    from byoc.providers.gdrive._http import DriveHttpClient

    payload = {"error": {"message": "m", "errors": [{"reason": reason}] if reason else []}}
    response = httpx.Response(status, json=payload)
    mapped = DriveHttpClient(lambda: "token").map_error(response)
    assert isinstance(mapped, expected)
