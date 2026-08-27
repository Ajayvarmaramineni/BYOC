"""S3 adapter unit tests driven through a mock HTTP transport.

These assert what goes on the wire -- URL shape, signed headers, error mapping,
pagination -- without needing a server. The MinIO integration suite covers the
half these cannot: that a real S3 implementation accepts them.
"""

from __future__ import annotations

import httpx
import pytest

from byoc.errors import (
    InvalidInputError,
    ObjectNotFoundError,
    PermissionDeniedError,
    StorageError,
)
from byoc.providers.s3 import S3CompatibleProvider

_LIST_XML_PAGE_1 = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>TOKEN-2</NextContinuationToken>
  <CommonPrefixes><Prefix>docs/reports/</Prefix></CommonPrefixes>
  <Contents>
    <Key>docs/a.txt</Key><Size>11</Size>
    <ETag>&quot;abc123&quot;</ETag><LastModified>2026-08-25T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>"""

_LIST_XML_PAGE_2 = """<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>docs/b.txt</Key><Size>22</Size>
  </Contents>
</ListBucketResult>"""


def _provider(handler: object, **kwargs: object) -> S3CompatibleProvider:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    defaults: dict[str, object] = {
        "endpoint": "https://acct.r2.cloudflarestorage.com",
        "bucket": "user-assets",
        "region": "auto",
        "access_key_id": "AKIDEXAMPLE",
        "secret_access_key": "secret",
        "client": httpx.AsyncClient(transport=transport),
    }
    defaults.update(kwargs)
    return S3CompatibleProvider(**defaults)  # type: ignore[arg-type]


def test_requires_credentials() -> None:
    with pytest.raises(InvalidInputError):
        S3CompatibleProvider(
            endpoint="", bucket="", region="auto", access_key_id="", secret_access_key=""
        )


def test_manifest_and_capabilities() -> None:
    provider = _provider(lambda request: httpx.Response(200))
    assert provider.manifest().id == "s3-compatible"
    assert provider.manifest().category == "developer-cloud"
    caps = provider.capabilities()
    # S3 has no native folders or account quota; those must not be faked.
    assert caps.folders is False
    assert caps.quota is False
    assert caps.public_urls is True


async def test_upload_signs_and_encodes_the_key() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["ctype"] = request.headers.get("content-type")
        return httpx.Response(200, headers={"etag": '"deadbeef"'})

    provider = _provider(handler, root_prefix="production/data")
    obj = await provider.upload("users/123/avatar.png", b"PNG", None)

    assert seen["url"] == (
        "https://acct.r2.cloudflarestorage.com/production/data/users/123/avatar.png"
    )
    assert str(seen["auth"]).startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert obj.checksum == "deadbeef"
    assert obj.provider_id == "production/data/users/123/avatar.png"


@pytest.mark.parametrize(
    ("filename", "encoded"),
    [
        ("notes/draft#2.pdf", "notes/draft%232.pdf"),
        ("notes/what?.txt", "notes/what%3F.txt"),
        ("Q3 report.pdf", "Q3%20report.pdf"),
        ("docs/café.txt", "docs/caf%C3%A9.txt"),
    ],
)
async def test_object_keys_survive_url_encoding(filename: str, encoded: str) -> None:
    """A '#' or '?' left unencoded silently truncates the key and loses data."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, headers={"etag": '"x"'})

    provider = _provider(handler)
    await provider.upload(filename, b"data", None)
    assert seen["url"] == f"https://acct.r2.cloudflarestorage.com/{encoded}"


async def test_download_returns_bytes_and_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"Hello S3",
            headers={"content-type": "text/plain", "content-length": "8", "etag": '"e1"'},
        )

    provider = _provider(handler)
    out = await provider.download("notes.txt")
    assert await out.read() == b"Hello S3"
    assert await out.text() == "Hello S3"
    assert out.metadata.mime_type == "text/plain"
    assert out.metadata.size == 8
    assert out.metadata.checksum == "e1"


async def test_download_maps_404_to_object_not_found() -> None:
    provider = _provider(
        lambda request: httpx.Response(404, text="<Error><Code>NoSuchKey</Code></Error>")
    )
    with pytest.raises(ObjectNotFoundError) as excinfo:
        await provider.download("missing.txt")
    assert excinfo.value.code == "BYOC_OBJECT_NOT_FOUND"


async def test_maps_403_to_permission_denied() -> None:
    provider = _provider(
        lambda request: httpx.Response(403, text="<Error><Code>AccessDenied</Code></Error>")
    )
    with pytest.raises(PermissionDeniedError):
        await provider.download("secret.txt")


async def test_delete_treats_missing_object_as_success() -> None:
    """S3 delete is idempotent; a 404 must not surface as an error."""
    provider = _provider(lambda request: httpx.Response(404, text="NoSuchKey"))
    await provider.delete("already-gone.txt")


async def test_exists_returns_false_without_raising() -> None:
    provider = _provider(lambda request: httpx.Response(404))
    assert await provider.exists("nope.txt") is False


async def test_list_follows_pagination() -> None:
    """Object 1001 must not vanish: ListObjectsV2 caps each page at 1000 keys."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        token = request.url.params.get("continuation-token")
        return httpx.Response(200, text=_LIST_XML_PAGE_2 if token else _LIST_XML_PAGE_1)

    provider = _provider(handler)
    objects = await provider.list("docs")

    assert len(calls) == 2
    assert "continuation-token=TOKEN-2" in calls[1]

    paths = [o.path for o in objects]
    assert paths == ["docs/reports", "docs/a.txt", "docs/b.txt"]
    assert objects[0].type == "folder"
    assert objects[1].type == "file"
    assert objects[1].size == 11
    assert objects[1].checksum == "abc123"


async def test_retries_transient_5xx_then_succeeds() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(503, text="SlowDown")
        return httpx.Response(200, content=b"ok", headers={"content-type": "text/plain"})

    provider = _provider(handler)
    out = await provider.download("flaky.txt")
    assert await out.read() == b"ok"
    assert attempts["n"] == 3


async def test_does_not_retry_a_non_retryable_error() -> None:
    """Retrying a 403 burns attempts on something that cannot succeed."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(403, text="AccessDenied")

    provider = _provider(handler)
    with pytest.raises(StorageError):
        await provider.download("denied.txt")
    assert attempts["n"] == 1


def test_presigned_url_is_query_authenticated() -> None:
    provider = _provider(lambda request: httpx.Response(200))
    url = provider.presigned_url("notes/draft#2.pdf", expires_in_seconds=900)
    assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url
    assert "X-Amz-Expires=900" in url
    assert "X-Amz-Signature=" in url
    assert "draft%232.pdf" in url


def test_force_path_style_puts_bucket_in_the_path() -> None:
    """MinIO and most self-hosted gateways require path-style addressing."""
    provider = _provider(lambda request: httpx.Response(200), force_path_style=True)
    assert provider.object_url("a/b.txt").endswith("/user-assets/a/b.txt")
