"""AsyncBYOC driven against a real S3 server.

The unit tests exercise the client against an in-memory provider; this proves
the same code paths work when the provider is doing real HTTP, real signing, and
real error mapping.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from byoc import AsyncBYOC, ConflictStrategy
from byoc.errors import CapabilityUnsupportedError, ObjectNotFoundError
from byoc.providers.s3 import S3CompatibleProvider

from .test_s3_minio import (
    ACCESS_KEY,
    BUCKET,
    ENDPOINT,
    REGION,
    SECRET_KEY,
    _ensure_bucket,
    requires_minio,
)

pytestmark = pytest.mark.integration


def _provider(provider_prefix: str) -> S3CompatibleProvider:
    return S3CompatibleProvider(
        endpoint=ENDPOINT,
        bucket=BUCKET,
        region=REGION,
        access_key_id=ACCESS_KEY,
        secret_access_key=SECRET_KEY,
        root_prefix=provider_prefix,
        force_path_style=True,
    )


@pytest_asyncio.fixture
async def storage() -> AsyncIterator[AsyncBYOC]:
    await _ensure_bucket()
    run = uuid.uuid4().hex[:8]
    client = AsyncBYOC(provider=_provider(f"client-{run}"), max_file_size_bytes=1_000_000)
    await client.connect()
    try:
        yield client
    finally:
        await client.disconnect()


@requires_minio
async def test_write_and_read_text(storage: AsyncBYOC) -> None:
    await storage.write_text("docs/note.md", "# Live from MinIO")
    assert await storage.read_text("docs/note.md") == "# Live from MinIO"


@requires_minio
async def test_mime_type_detection_survives_the_round_trip(storage: AsyncBYOC) -> None:
    await storage.write_bytes("images/logo.png", b"\x89PNG\r\n\x1a\n")
    meta = await storage.metadata("images/logo.png")
    assert meta.mime_type == "image/png"


@requires_minio
async def test_exists_delete_and_list(storage: AsyncBYOC) -> None:
    await storage.write_text("docs/a.txt", "a")
    await storage.write_text("docs/b.txt", "bb")

    assert await storage.exists("docs/a.txt") is True
    listed = await storage.list("docs")
    assert sorted(o.name for o in listed) == ["a.txt", "b.txt"]

    await storage.delete("docs/a.txt")
    assert await storage.exists("docs/a.txt") is False


@requires_minio
async def test_missing_object_raises_not_found(storage: AsyncBYOC) -> None:
    with pytest.raises(ObjectNotFoundError):
        await storage.read_text("docs/never-written.md")


@requires_minio
async def test_unsupported_capabilities_raise(storage: AsyncBYOC) -> None:
    """S3 has no real folders and reports no quota; both must say so honestly."""
    with pytest.raises(CapabilityUnsupportedError):
        await storage.create_folder("docs")
    with pytest.raises(CapabilityUnsupportedError):
        await storage.get_quota()


@requires_minio
async def test_backup_helper_writes_to_the_server(storage: AsyncBYOC) -> None:
    obj = await storage.backup(b'{"rows": 1}')
    assert obj.path.startswith("Backups/backup-")
    assert await storage.exists(obj.path) is True


@requires_minio
async def test_migrate_between_two_live_prefixes() -> None:
    """Two S3 prefixes stand in for two clouds: the engine only sees providers."""
    await _ensure_bucket()
    run = uuid.uuid4().hex[:8]
    source = _provider(f"mig-src-{run}")
    target = _provider(f"mig-dst-{run}")

    client = AsyncBYOC(providers=[source, target])
    # Both adapters share the same manifest id, so register them distinctly by
    # driving the engine through the source/target adapters directly.
    from byoc.migration import migrate as run_migration

    await source.connect()
    await target.connect()
    try:
        await source.upload("reports/q3.pdf", b"PDF BYTES", None)
        await source.upload("reports/q4.pdf", b"MORE BYTES", None)

        report = await run_migration(
            source=source,
            target=target,
            paths=["reports/q3.pdf", "reports/q4.pdf"],
            conflict_strategy=ConflictStrategy.OVERWRITE,
        )

        assert report.files_migrated == 2
        assert report.files_failed == 0
        assert report.bytes_transferred == 19
        assert await target.exists("reports/q3.pdf") is True
        assert await (await target.download("reports/q4.pdf")).read() == b"MORE BYTES"
    finally:
        await source.disconnect()
        await target.disconnect()
        await client.disconnect()
