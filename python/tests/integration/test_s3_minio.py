"""Live S3 integration tests against a real MinIO server.

Mock transports prove what we *send*; only a real S3 implementation proves it
*accepts* our signatures. Every serious bug this adapter's TypeScript sibling
had -- header casing, query canonicalization, unencoded ``#`` in keys -- was
invisible to mocks and would have surfaced here on the first request.

Skipped automatically when MinIO is not reachable, so the default test run stays
offline. Start one with::

    docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \\
        -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio

from byoc.errors import ObjectNotFoundError
from byoc.providers._sigv4 import sign_s3_request
from byoc.providers.s3 import S3CompatibleProvider

ENDPOINT = os.environ.get("BYOC_TEST_S3_ENDPOINT", "http://127.0.0.1:9000")
ACCESS_KEY = os.environ.get("BYOC_TEST_S3_ACCESS_KEY", "minioadmin")
SECRET_KEY = os.environ.get("BYOC_TEST_S3_SECRET_KEY", "minioadmin")
REGION = os.environ.get("BYOC_TEST_S3_REGION", "us-east-1")
BUCKET = os.environ.get("BYOC_TEST_S3_BUCKET", "byoc-integration")

pytestmark = pytest.mark.integration


def _server_is_up() -> bool:
    try:
        httpx.get(f"{ENDPOINT}/minio/health/live", timeout=2.0)
    except httpx.HTTPError:
        return False
    return True


requires_minio = pytest.mark.skipif(
    not _server_is_up(), reason=f"No S3-compatible server reachable at {ENDPOINT}"
)


async def _ensure_bucket() -> None:
    """Create the test bucket, tolerating one that already exists."""
    url = f"{ENDPOINT}/{BUCKET}"
    headers = sign_s3_request(
        access_key_id=ACCESS_KEY,
        secret_access_key=SECRET_KEY,
        region=REGION,
        method="PUT",
        url=url,
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.put(url, headers=headers)

    already_exists = any(
        marker in response.text for marker in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists")
    )
    if response.is_error and not already_exists:
        raise AssertionError(
            f"Could not create bucket: HTTP {response.status_code} {response.text}"
        )


@pytest_asyncio.fixture
async def provider() -> AsyncIterator[S3CompatibleProvider]:
    await _ensure_bucket()
    adapter = S3CompatibleProvider(
        endpoint=ENDPOINT,
        bucket=BUCKET,
        region=REGION,
        access_key_id=ACCESS_KEY,
        secret_access_key=SECRET_KEY,
        root_prefix=f"run-{uuid.uuid4().hex[:8]}",
        force_path_style=True,
    )
    await adapter.connect()
    try:
        yield adapter
    finally:
        await adapter.disconnect()


@requires_minio
async def test_upload_download_roundtrip(provider: S3CompatibleProvider) -> None:
    await provider.upload("docs/hello.txt", "Hello from BYOC", None)
    out = await provider.download("docs/hello.txt")
    assert await out.text() == "Hello from BYOC"
    assert out.metadata.size == 15


@requires_minio
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
async def test_awkward_filenames_roundtrip(provider: S3CompatibleProvider, filename: str) -> None:
    """The exact filenames that broke the TypeScript adapter before it was fixed."""
    await provider.upload(filename, f"content of {filename}", None)
    out = await provider.download(filename)
    assert await out.text() == f"content of {filename}"


@requires_minio
async def test_exists_and_delete(provider: S3CompatibleProvider) -> None:
    await provider.upload("temp.txt", b"x", None)
    assert await provider.exists("temp.txt") is True

    await provider.delete("temp.txt")
    assert await provider.exists("temp.txt") is False

    # Deleting again must stay silent: S3 delete is idempotent.
    await provider.delete("temp.txt")


@requires_minio
async def test_metadata_of_missing_object_raises(provider: S3CompatibleProvider) -> None:
    with pytest.raises(ObjectNotFoundError):
        await provider.metadata("never-written.txt")


@requires_minio
async def test_list_returns_files_and_folders(provider: S3CompatibleProvider) -> None:
    await provider.upload("docs/a.txt", b"a", None)
    await provider.upload("docs/b.txt", b"bb", None)
    await provider.upload("docs/nested/c.txt", b"ccc", None)

    listed = await provider.list("docs")
    names = sorted(o.name for o in listed)
    assert names == ["a.txt", "b.txt", "nested"]

    by_name = {o.name: o for o in listed}
    assert by_name["nested"].type == "folder"
    assert by_name["b.txt"].size == 2


@requires_minio
async def test_list_pagination_past_one_page(provider: S3CompatibleProvider) -> None:
    """Exercises the continuation-token loop against a real server."""
    for index in range(12):
        await provider.upload(f"many/file-{index:03d}.txt", b"x", None)

    listed = await provider.list("many")
    assert len([o for o in listed if o.type == "file"]) == 12


@requires_minio
async def test_custom_metadata_roundtrips(provider: S3CompatibleProvider) -> None:
    from byoc.types import UploadOptions

    await provider.upload(
        "meta.txt", b"data", UploadOptions(mime_type="text/plain", metadata={"Author": "Alice"})
    )
    meta = await provider.metadata("meta.txt")
    assert meta.mime_type == "text/plain"


@requires_minio
async def test_presigned_url_is_accepted_by_the_server(provider: S3CompatibleProvider) -> None:
    """A presigned URL must work with no Authorization header at all."""
    await provider.upload("shared/report.pdf", b"PDF BYTES", None)
    url = provider.presigned_url("shared/report.pdf", expires_in_seconds=300)

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(url)

    assert response.status_code == 200, response.text
    assert response.content == b"PDF BYTES"


@pytest.mark.integration
async def test_streams_an_unknown_length_body_as_multipart(
    provider: S3CompatibleProvider,
) -> None:
    """S3 answers 411 Length Required to a chunked PUT.

    A stream whose size is not known up front therefore cannot go in one
    request; it has to become a multipart upload. This exercises a payload
    spanning several parts so the part-boundary logic is really used.
    """
    part = 8 * 1024 * 1024
    total = part * 2 + 1024  # three parts, the last one short

    async def chunks() -> AsyncIterator[bytes]:
        remaining = total
        while remaining > 0:
            size = min(1024 * 1024, remaining)
            remaining -= size
            yield b"s" * size

    written = await provider.upload("streamed/multipart.bin", chunks())

    assert written.size == total
    assert (await provider.metadata("streamed/multipart.bin")).size == total

    downloaded = await (await provider.download("streamed/multipart.bin")).read()
    assert len(downloaded) == total
    assert downloaded == b"s" * total

    await provider.delete("streamed/multipart.bin")


@pytest.mark.integration
async def test_streams_an_empty_body(provider: S3CompatibleProvider) -> None:
    """S3 rejects a zero-part multipart upload, so an empty stream still needs one."""

    async def nothing() -> AsyncIterator[bytes]:
        return
        yield b""  # pragma: no cover - makes this an async generator

    written = await provider.upload("streamed/empty.bin", nothing())

    assert written.size == 0
    assert await (await provider.download("streamed/empty.bin")).read() == b""

    await provider.delete("streamed/empty.bin")


@pytest.mark.integration
async def test_a_streamed_upload_reports_progress(
    provider: S3CompatibleProvider,
) -> None:
    from byoc.types import UploadOptions

    seen: list[int] = []

    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(12):
            yield b"p" * (1024 * 1024)

    await provider.upload(
        "streamed/progress.bin",
        chunks(),
        UploadOptions(on_progress=lambda p: seen.append(p.bytes_uploaded)),
    )

    assert seen, "a streamed upload must report progress"
    assert seen == sorted(seen), "progress must not go backwards"
    assert seen[-1] == 12 * 1024 * 1024

    await provider.delete("streamed/progress.bin")
