"""Live WebDAV integration tests against a real RFC 4918 server.

Runs an in-process ``wsgidav`` server, so these execute anywhere without Docker.
That matters: PROPFIND multistatus parsing, MKCOL ancestor creation, and href
decoding are all things a mock would happily accept while a real server
rejected them.

Point the suite at Nextcloud or ownCloud instead by setting
``BYOC_TEST_WEBDAV_ENDPOINT`` (plus ``_USERNAME`` / ``_PASSWORD``).
"""

from __future__ import annotations

import os
import tempfile
import threading
import uuid
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio

from byoc import AsyncBYOC
from byoc.errors import ObjectNotFoundError, PermissionDeniedError
from byoc.providers.webdav import WebDAVProvider

pytestmark = pytest.mark.integration

EXTERNAL_ENDPOINT = os.environ.get("BYOC_TEST_WEBDAV_ENDPOINT")
USERNAME = os.environ.get("BYOC_TEST_WEBDAV_USERNAME", "byoc")
PASSWORD = os.environ.get("BYOC_TEST_WEBDAV_PASSWORD", "byoc-secret")


@pytest.fixture(scope="module")
def webdav_endpoint() -> Iterator[str]:
    """Yield a WebDAV endpoint, starting a local server unless one is configured."""
    if EXTERNAL_ENDPOINT:
        yield EXTERNAL_ENDPOINT.rstrip("/")
        return

    from cheroot import wsgi
    from wsgidav.wsgidav_app import WsgiDAVApp

    root = tempfile.mkdtemp(prefix="byoc-webdav-")
    app = WsgiDAVApp(
        {
            "provider_mapping": {"/": root},
            "simple_dc": {"user_mapping": {"*": {USERNAME: {"password": PASSWORD}}}},
            "http_authenticator": {"accept_basic": True, "accept_digest": False},
            "verbose": 0,
            "logging": {"enable": False},
        }
    )
    server = wsgi.Server(bind_addr=("127.0.0.1", 0), wsgi_app=app)
    server.prepare()
    port = server.bind_addr[1]

    thread = threading.Thread(target=server.serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.stop()


@pytest_asyncio.fixture
async def provider(webdav_endpoint: str) -> AsyncIterator[WebDAVProvider]:
    adapter = WebDAVProvider(
        endpoint=webdav_endpoint,
        username=USERNAME,
        password=PASSWORD,
        root_folder=f"byoc-{uuid.uuid4().hex[:8]}",
    )
    await adapter.connect()
    try:
        yield adapter
    finally:
        await adapter.disconnect()


async def test_upload_download_roundtrip(provider: WebDAVProvider) -> None:
    await provider.upload("docs/hello.txt", "Hello from WebDAV", None)
    out = await provider.download("docs/hello.txt")
    assert await out.text() == "Hello from WebDAV"
    assert out.metadata.size == 17


async def test_nested_folders_are_created_on_upload(provider: WebDAVProvider) -> None:
    """WebDAV PUT fails unless every ancestor collection already exists."""
    await provider.upload("a/b/c/d/deep.txt", b"deep", None)
    assert await provider.exists("a/b/c/d/deep.txt") is True


@pytest.mark.parametrize(
    "filename",
    [
        "notes/draft#2.pdf",
        "notes/what?.txt",
        "Q3 report/a b.pdf",
        "docs/café/naïve.txt",
        "notes/Bob's Notes.pdf",
        "docs/a&b+c.txt",
    ],
)
async def test_awkward_filenames_roundtrip(provider: WebDAVProvider, filename: str) -> None:
    """Percent-encoding must survive both the PUT URL and the PROPFIND href."""
    await provider.upload(filename, f"content of {filename}", None)
    assert await (await provider.download(filename)).text() == f"content of {filename}"


async def test_returned_paths_round_trip(provider: WebDAVProvider) -> None:
    """A returned path must be usable as an input path: root_folder must not leak."""
    obj = await provider.upload("docs/report.md", b"x", None)
    assert obj.path == "docs/report.md"
    assert await provider.exists(obj.path) is True


async def test_exists_and_delete(provider: WebDAVProvider) -> None:
    await provider.upload("temp.txt", b"x", None)
    assert await provider.exists("temp.txt") is True

    await provider.delete("temp.txt")
    assert await provider.exists("temp.txt") is False
    # Deleting a missing file must stay silent.
    await provider.delete("temp.txt")


async def test_metadata_of_missing_object_raises(provider: WebDAVProvider) -> None:
    with pytest.raises(ObjectNotFoundError):
        await provider.metadata("never-written.txt")


async def test_list_returns_files_and_folders(provider: WebDAVProvider) -> None:
    await provider.upload("docs/a.txt", b"a", None)
    await provider.upload("docs/b.txt", b"bb", None)
    await provider.upload("docs/nested/c.txt", b"ccc", None)

    listed = await provider.list("docs")
    by_name = {o.name: o for o in listed}

    assert sorted(by_name) == ["a.txt", "b.txt", "nested"]
    assert by_name["nested"].type == "folder"
    assert by_name["b.txt"].type == "file"
    assert by_name["b.txt"].size == 2
    # Listed paths must be virtual, so they can be fed straight back in.
    assert by_name["a.txt"].path == "docs/a.txt"


async def test_create_folder_and_list_it(provider: WebDAVProvider) -> None:
    await provider.create_folder("empty/deep")
    listed = await provider.list("empty")
    assert [o.name for o in listed] == ["deep"]


async def test_server_side_move(provider: WebDAVProvider) -> None:
    await provider.upload("old/name.txt", b"payload", None)
    await provider.move("old/name.txt", "new/renamed.txt")

    assert await provider.exists("old/name.txt") is False
    assert await (await provider.download("new/renamed.txt")).read() == b"payload"


async def test_server_side_copy(provider: WebDAVProvider) -> None:
    await provider.upload("src/original.txt", b"payload", None)
    await provider.copy("src/original.txt", "dst/duplicate.txt")

    assert await provider.exists("src/original.txt") is True
    assert await (await provider.download("dst/duplicate.txt")).read() == b"payload"


async def test_quota_is_reported(provider: WebDAVProvider) -> None:
    quota = await provider.quota()
    assert quota.used >= 0


async def test_through_the_byoc_client(webdav_endpoint: str) -> None:
    """The universal client over a live WebDAV backend."""
    storage = AsyncBYOC(
        provider=WebDAVProvider(
            endpoint=webdav_endpoint,
            username=USERNAME,
            password=PASSWORD,
            root_folder=f"client-{uuid.uuid4().hex[:8]}",
        )
    )
    async with storage:
        await storage.write_text("notes/todo.md", "# This week")
        assert await storage.read_text("notes/todo.md") == "# This week"

        # WebDAV declares folders and quota, unlike S3.
        assert storage.has_capability("folders") is True
        await storage.create_folder("archive")
        assert (await storage.get_quota()).used >= 0


async def test_bad_credentials_are_rejected(webdav_endpoint: str) -> None:
    adapter = WebDAVProvider(
        endpoint=webdav_endpoint, username=USERNAME, password="wrong-password", root_folder="x"
    )
    try:
        with pytest.raises(PermissionDeniedError):
            await adapter.upload("denied.txt", b"x", None)
    finally:
        await adapter.disconnect()
