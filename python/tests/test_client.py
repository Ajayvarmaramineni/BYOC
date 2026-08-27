"""AsyncBYOC client and migration engine, driven by an in-memory provider."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from byoc import AsyncBYOC, ConflictStrategy
from byoc.errors import CapabilityUnsupportedError, InvalidInputError
from byoc.types import (
    ProviderCapabilities,
    ProviderManifest,
    StorageInput,
    StorageObject,
    StorageOutput,
    StorageQuota,
    UploadOptions,
)


class MemoryProvider:
    """Minimal in-memory BYOCProvider for exercising client behaviour."""

    def __init__(self, provider_id: str = "memory", *, folders: bool = True, quota: bool = True):
        self.id = provider_id
        self.store: dict[str, tuple[bytes, str | None]] = {}
        self.connected = False
        self.fail_delete = False
        self._folders = folders
        self._quota = quota

    def manifest(self) -> ProviderManifest:
        return ProviderManifest(
            id=self.id,
            name=f"Memory ({self.id})",
            category="self-hosted",
            authentication="basic",
            supports_user_owned_storage=True,
            adapter_version="0.2.0",
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(folders=self._folders, quota=self._quota)

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.connected = False

    async def upload(
        self, path: str, data: StorageInput, options: UploadOptions | None = None
    ) -> StorageObject:
        payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)  # type: ignore[arg-type]
        mime = options.mime_type if options else None
        self.store[path] = (payload, mime)
        return StorageObject(
            id=f"{self.id}_{path}",
            path=path,
            name=path.rsplit("/", 1)[-1],
            provider=self.id,
            provider_id=path,
            size=len(payload),
            mime_type=mime,
        )

    async def download(self, path: str) -> StorageOutput:
        if path not in self.store:
            from byoc.errors import ObjectNotFoundError

            raise ObjectNotFoundError(f"Not found: {path}", provider=self.id)
        payload, mime = self.store[path]

        async def stream() -> AsyncIterator[bytes]:
            yield payload

        async def read() -> bytes:
            return payload

        return StorageOutput(
            metadata=StorageObject(
                id=f"{self.id}_{path}",
                path=path,
                name=path.rsplit("/", 1)[-1],
                provider=self.id,
                provider_id=path,
                size=len(payload),
                mime_type=mime,
            ),
            stream=stream,
            read=read,
        )

    async def delete(self, path: str) -> None:
        if self.fail_delete:
            from byoc.errors import PermissionDeniedError

            raise PermissionDeniedError("read-only source", provider=self.id)
        self.store.pop(path, None)

    async def list(self, path: str | None = None) -> list[StorageObject]:
        prefix = f"{path}/" if path else ""
        return [
            StorageObject(
                id=f"{self.id}_{key}",
                path=key,
                name=key.rsplit("/", 1)[-1],
                provider=self.id,
                provider_id=key,
            )
            for key in self.store
            if key.startswith(prefix)
        ]

    async def exists(self, path: str) -> bool:
        return path in self.store

    async def metadata(self, path: str) -> StorageObject:
        return (await self.download(path)).metadata

    async def quota(self) -> StorageQuota:
        used = sum(len(v[0]) for v in self.store.values())
        return StorageQuota(used=used, total=1000, available=1000 - used)


def test_requires_at_least_one_provider() -> None:
    with pytest.raises(InvalidInputError):
        AsyncBYOC()


async def test_write_and_read_text_roundtrip() -> None:
    storage = AsyncBYOC(provider=MemoryProvider())
    await storage.connect()
    await storage.write_text("docs/note.md", "# Hello")
    assert await storage.read_text("docs/note.md") == "# Hello"


async def test_paths_are_normalized_before_reaching_the_provider() -> None:
    provider = MemoryProvider()
    storage = AsyncBYOC(provider=provider)
    await storage.write_text("///docs//../..//".replace("..", "x"), "v")
    await storage.write_text("/docs//note.md/", "value")
    assert "docs/note.md" in provider.store


async def test_upload_rejects_traversal() -> None:
    storage = AsyncBYOC(provider=MemoryProvider())
    with pytest.raises(InvalidInputError):
        await storage.write_text("../escape.txt", "nope")


async def test_mime_type_is_detected_from_the_path() -> None:
    provider = MemoryProvider()
    storage = AsyncBYOC(provider=provider)
    obj = await storage.upload("images/logo.png", b"PNG")
    assert obj.mime_type == "image/png"


async def test_max_file_size_is_enforced() -> None:
    storage = AsyncBYOC(provider=MemoryProvider(), max_file_size_bytes=4)
    with pytest.raises(InvalidInputError):
        await storage.write_bytes("big.bin", b"12345")


async def test_exists_and_delete() -> None:
    storage = AsyncBYOC(provider=MemoryProvider())
    await storage.write_text("a.txt", "x")
    assert await storage.exists("a.txt") is True
    await storage.delete("a.txt")
    assert await storage.exists("a.txt") is False
    # An empty path is the root, never a file.
    assert await storage.exists("") is False


async def test_provider_switching() -> None:
    drive = MemoryProvider("google-drive")
    s3 = MemoryProvider("s3-compatible")
    storage = AsyncBYOC(providers=[drive, s3], default_provider_id="s3-compatible")

    assert storage.manifest().id == "s3-compatible"
    await storage.write_text("only-on-s3.txt", "v")

    storage.use_provider("google-drive")
    assert storage.manifest().id == "google-drive"
    assert await storage.exists("only-on-s3.txt") is False

    assert sorted(m.id for m in storage.get_providers()) == ["google-drive", "s3-compatible"]


async def test_unknown_provider_lists_the_available_ones() -> None:
    storage = AsyncBYOC(provider=MemoryProvider("memory"))
    with pytest.raises(InvalidInputError) as excinfo:
        storage.use_provider("dropbox")
    assert "memory" in str(excinfo.value)


async def test_capability_gated_operations_raise_when_unsupported() -> None:
    storage = AsyncBYOC(provider=MemoryProvider(folders=False, quota=False))
    with pytest.raises(CapabilityUnsupportedError):
        await storage.create_folder("docs")
    with pytest.raises(CapabilityUnsupportedError):
        await storage.get_quota()
    # move() is absent from MemoryProvider entirely.
    with pytest.raises(CapabilityUnsupportedError):
        await storage.move("a.txt", "b.txt")


async def test_quota_is_returned_when_supported() -> None:
    storage = AsyncBYOC(provider=MemoryProvider())
    await storage.write_bytes("a.bin", b"1234")
    quota = await storage.get_quota()
    assert quota.used == 4
    assert quota.available == 996


async def test_backup_writes_a_timestamped_file() -> None:
    provider = MemoryProvider()
    storage = AsyncBYOC(provider=provider)
    obj = await storage.backup(b'{"rows":1}')
    assert obj.path.startswith("Backups/backup-")
    assert obj.path.endswith(".json")


async def test_async_context_manager_connects_and_disconnects() -> None:
    provider = MemoryProvider()
    async with AsyncBYOC(provider=provider) as storage:
        assert provider.connected is True
        await storage.write_text("x.txt", "y")
    assert provider.connected is False


# -- migration ---------------------------------------------------------------


async def test_migrate_between_providers() -> None:
    source = MemoryProvider("google-drive")
    target = MemoryProvider("webdav")
    storage = AsyncBYOC(providers=[source, target])

    await source.upload("docs/a.txt", b"aaa")
    await source.upload("docs/b.txt", b"bb")

    report = await storage.migrate(
        source="google-drive", target="webdav", paths=["docs/a.txt", "docs/b.txt"]
    )

    assert report.files_total == 2
    assert report.files_migrated == 2
    assert report.files_failed == 0
    assert report.bytes_transferred == 5
    assert await target.exists("docs/a.txt")


async def test_migrate_reports_partial_when_source_delete_fails() -> None:
    """The copy landed; only cleanup failed. Retrying would re-upload for nothing."""
    source = MemoryProvider("src")
    target = MemoryProvider("dst")
    source.fail_delete = True
    await source.upload("vault/key.pem", b"SECRET")

    storage = AsyncBYOC(providers=[source, target])
    report = await storage.migrate(
        source="src", target="dst", paths=["vault/key.pem"], delete_source_after_migrate=True
    )

    assert report.files_migrated == 0
    assert report.files_failed == 0
    assert report.files_partial == 1
    # Exactly one record for one input file: no double-counting.
    assert len(report.results) == 1
    assert report.results[0].status == "partial"

    # The point of 'partial': the target copy really exists...
    assert await target.exists("vault/key.pem")
    # ...and the source is still there, awaiting cleanup.
    assert await source.exists("vault/key.pem")


async def test_migrate_reports_failed_when_the_upload_fails() -> None:
    source = MemoryProvider("src")
    target = MemoryProvider("dst")
    await source.upload("a.txt", b"x")

    async def boom(*args: object, **kwargs: object) -> StorageObject:
        raise RuntimeError("quota exceeded on target")

    target.upload = boom  # type: ignore[assignment]

    storage = AsyncBYOC(providers=[source, target])
    report = await storage.migrate(
        source="src", target="dst", paths=["a.txt"], delete_source_after_migrate=True
    )

    assert report.files_failed == 1
    assert report.files_partial == 0
    # A real transfer failure must never delete the source.
    assert await source.exists("a.txt")


async def test_migrate_skip_strategy() -> None:
    source = MemoryProvider("src")
    target = MemoryProvider("dst")
    await source.upload("a.txt", b"new")
    await target.upload("a.txt", b"old")

    storage = AsyncBYOC(providers=[source, target])
    report = await storage.migrate(
        source="src", target="dst", paths=["a.txt"], conflict_strategy=ConflictStrategy.SKIP
    )

    assert report.files_skipped == 1
    assert (await (await target.download("a.txt")).read()) == b"old"


async def test_migrate_error_strategy_records_failure() -> None:
    source = MemoryProvider("src")
    target = MemoryProvider("dst")
    await source.upload("a.txt", b"new")
    await target.upload("a.txt", b"old")

    storage = AsyncBYOC(providers=[source, target])
    report = await storage.migrate(
        source="src", target="dst", paths=["a.txt"], conflict_strategy=ConflictStrategy.ERROR
    )
    assert report.files_failed == 1


async def test_migrate_progress_reaches_one_hundred_percent() -> None:
    source = MemoryProvider("src")
    target = MemoryProvider("dst")
    for i in range(4):
        await source.upload(f"f{i}.txt", b"x")

    events: list[int] = []
    storage = AsyncBYOC(providers=[source, target])
    await storage.migrate(
        source="src",
        target="dst",
        paths=[f"f{i}.txt" for i in range(4)],
        on_progress=lambda p: events.append(p.percentage),
    )

    assert len(events) == 4
    assert events[-1] == 100


async def test_migrate_unknown_provider_raises() -> None:
    storage = AsyncBYOC(provider=MemoryProvider("only"))
    with pytest.raises(InvalidInputError):
        await storage.migrate(source="nope", target="only", paths=["a.txt"])


async def test_migrate_with_no_paths_returns_an_empty_report() -> None:
    storage = AsyncBYOC(providers=[MemoryProvider("a"), MemoryProvider("b")])
    report = await storage.migrate(source="a", target="b", paths=[])
    assert report.files_total == 0
    assert report.results == []
