"""Behavioural suite for the two credential-free providers.

Both are driven through the same assertions, because the point of shipping
them is that code written against one BYOC provider behaves the same against
any other. A divergence here is a bug in whichever one differs.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pytest

from byoc import AsyncBYOC, LocalFileSystemProvider, MemoryProvider
from byoc.errors import (
    CapabilityUnsupportedError,
    InvalidInputError,
    ObjectNotFoundError,
    PermissionDeniedError,
)
from byoc.types import BYOCProvider, UploadOptions

# Filenames that have historically broken adapters: `#` and `?` truncated an
# object key, `+` was mis-decoded as a space, and non-ASCII broke signing.
AWKWARD_NAMES = ["draft#2.pdf", "q?x.txt", "sp ace.txt", "ümlaut.txt", "a+b.txt", "100%.txt"]


ProviderFactory = Callable[[Path], BYOCProvider]


def _local(tmp: Path) -> BYOCProvider:
    return LocalFileSystemProvider(tmp / "root")


def _memory(_: Path) -> BYOCProvider:
    return MemoryProvider(quota_bytes=1024 * 1024)


ALL_PROVIDERS = [
    pytest.param(_local, True, id="local"),
    pytest.param(_memory, False, id="memory"),
]


@pytest.fixture
async def storage(
    request: pytest.FixtureRequest, tmp_path: Path
) -> AsyncIterator[AsyncBYOC]:
    """A connected client for whichever provider the test is parametrized over."""
    factory: ProviderFactory = request.param
    client = AsyncBYOC(provider=factory(tmp_path))
    await client.connect()
    try:
        yield client
    finally:
        await client.disconnect()


def _parametrize(func: object) -> object:
    return pytest.mark.parametrize(
        ("storage", "has_folders"), ALL_PROVIDERS, indirect=["storage"]
    )(func)


# -- round trips ------------------------------------------------------------


@_parametrize
async def test_write_then_read_round_trip(storage: AsyncBYOC, has_folders: bool) -> None:
    written = await storage.write_text("docs/report.md", "# Hello")

    assert written.path == "docs/report.md"
    assert written.size == 7
    assert await storage.read_text("docs/report.md") == "# Hello"
    assert await storage.read_bytes("docs/report.md") == b"# Hello"


@_parametrize
async def test_exists_distinguishes_present_from_missing(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    await storage.write_text("a.txt", "x")

    assert await storage.exists("a.txt") is True
    assert await storage.exists("missing.txt") is False
    # The root is a container, never a file.
    assert await storage.exists("") is False


@_parametrize
async def test_metadata_reports_size_and_mime(storage: AsyncBYOC, has_folders: bool) -> None:
    await storage.write_text("notes/readme.md", "hello world")
    found = await storage.metadata("notes/readme.md")

    assert found.size == 11
    assert found.mime_type is not None and "markdown" in found.mime_type
    assert found.name == "readme.md"
    assert found.path == "notes/readme.md"


@_parametrize
async def test_metadata_on_missing_object_raises(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    with pytest.raises(ObjectNotFoundError):
        await storage.metadata("nope.txt")


@_parametrize
async def test_download_missing_object_raises(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    with pytest.raises(ObjectNotFoundError):
        await storage.download("nope.txt")


@_parametrize
async def test_custom_metadata_survives_a_round_trip(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    await storage.upload(
        "tagged.bin",
        b"payload",
        UploadOptions(mime_type="application/x-custom", metadata={"owner": "alex"}),
    )
    found = await storage.metadata("tagged.bin")

    assert found.mime_type == "application/x-custom"
    assert found.metadata.get("owner") == "alex"


# -- listing ----------------------------------------------------------------


@_parametrize
async def test_list_returns_one_level_only(storage: AsyncBYOC, has_folders: bool) -> None:
    await storage.write_text("top.txt", "a")
    await storage.write_text("docs/one.txt", "b")
    await storage.write_text("docs/deep/two.txt", "c")

    names = sorted(item.name for item in await storage.list("docs"))

    assert "one.txt" in names
    # `deep/two.txt` must not appear as a flattened child.
    assert "two.txt" not in names


@_parametrize
async def test_listing_paths_can_be_fed_back_in(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """A returned path must be usable as an argument without translation."""
    await storage.write_text("docs/one.txt", "content")

    listed = [item for item in await storage.list("docs") if item.type != "folder"]
    assert listed, "expected at least one file"

    for item in listed:
        assert await storage.read_text(item.path) == "content"


# -- awkward filenames ------------------------------------------------------


@_parametrize
@pytest.mark.parametrize("name", AWKWARD_NAMES)
async def test_awkward_filenames_round_trip(
    storage: AsyncBYOC, has_folders: bool, name: str
) -> None:
    await storage.write_text(f"odd/{name}", f"payload::{name}")

    assert await storage.read_text(f"odd/{name}") == f"payload::{name}"
    assert name in {item.name for item in await storage.list("odd")}


@_parametrize
async def test_similar_names_do_not_collide(storage: AsyncBYOC, has_folders: bool) -> None:
    """The 0.1.0 bug: `draft#2.pdf` and `draft#3.pdf` both wrote to `draft`."""
    await storage.write_text("draft#2.pdf", "two")
    await storage.write_text("draft#3.pdf", "three")

    assert await storage.read_text("draft#2.pdf") == "two"
    assert await storage.read_text("draft#3.pdf") == "three"


# -- copy, move, delete -----------------------------------------------------


@_parametrize
async def test_copy_leaves_the_source_in_place(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    await storage.write_text("src.txt", "content")
    await storage.copy("src.txt", "nested/dst.txt")

    assert await storage.read_text("nested/dst.txt") == "content"
    assert await storage.exists("src.txt") is True


@_parametrize
async def test_move_removes_the_source(storage: AsyncBYOC, has_folders: bool) -> None:
    await storage.write_text("src.txt", "content")
    await storage.move("src.txt", "nested/dst.txt")

    assert await storage.read_text("nested/dst.txt") == "content"
    assert await storage.exists("src.txt") is False


@_parametrize
async def test_delete_is_idempotent(storage: AsyncBYOC, has_folders: bool) -> None:
    await storage.write_text("gone.txt", "x")
    await storage.delete("gone.txt")
    # A second delete is a no-op, not an error, on every adapter.
    await storage.delete("gone.txt")

    assert await storage.exists("gone.txt") is False


# -- streaming --------------------------------------------------------------


@_parametrize
async def test_download_stream_yields_the_whole_payload(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    payload = b"x" * 200_000
    await storage.write_bytes("big.bin", payload)

    output = await storage.download("big.bin")
    chunks = [chunk async for chunk in output.stream()]

    assert b"".join(chunks) == payload
    assert len(chunks) > 1, "a 200 KB payload should arrive in several chunks"


@_parametrize
async def test_upload_accepts_an_async_iterator(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """``StorageInput`` advertises async iterators, so they must work."""

    async def chunks() -> AsyncIterator[bytes]:
        for part in (b"str", b"eam", b"ed!"):
            yield part

    await storage.upload("streamed.bin", chunks())

    assert await storage.read_bytes("streamed.bin") == b"streamed!"


# -- recursive and batch operations ----------------------------------------


@_parametrize
async def test_walk_finds_objects_at_every_depth(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """Regression: on a flat provider ``walk`` returned only the top level.

    ``MemoryProvider`` did not emit synthetic folder entries for deeper keys,
    so there was nothing for the walk to descend into and everything nested
    was invisible.
    """
    for path in ("docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"):
        await storage.write_text(path, path)

    found = {item.path async for item in storage.walk("docs")}

    assert {"docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"} <= found


@_parametrize
async def test_walk_stays_within_the_requested_subtree(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    await storage.write_text("docs/inside.txt", "a")
    await storage.write_text("other/outside.txt", "b")

    found = {item.path async for item in storage.walk("docs")}

    assert "docs/inside.txt" in found
    assert "other/outside.txt" not in found


@_parametrize
async def test_delete_tree_removes_every_descendant(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """Regression: this reported success while leaving nested objects behind."""
    for path in ("docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"):
        await storage.write_text(path, path)
    await storage.write_text("keep.txt", "untouched")

    report = await storage.delete_tree("docs")

    assert report.all_succeeded, report.failed
    for path in ("docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"):
        assert await storage.exists(path) is False, f"{path} survived delete_tree"
    assert await storage.read_text("keep.txt") == "untouched"


@_parametrize
async def test_delete_tree_requires_a_path(storage: AsyncBYOC, has_folders: bool) -> None:
    # An empty path is the storage root; wiping it must be deliberate.
    with pytest.raises(InvalidInputError):
        await storage.delete_tree("")


@_parametrize
async def test_delete_many_reports_each_path(storage: AsyncBYOC, has_folders: bool) -> None:
    await storage.write_text("a.txt", "a")
    await storage.write_text("b.txt", "b")

    report = await storage.delete_many(["a.txt", "b.txt", "never-existed.txt"])

    # Deletion is idempotent everywhere, so a missing path is a success.
    assert sorted(report.deleted) == ["a.txt", "b.txt", "never-existed.txt"]
    assert report.failed == []
    assert report.total == 3
    assert report.all_succeeded is True


@_parametrize
async def test_delete_many_rejects_a_zero_concurrency(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    with pytest.raises(InvalidInputError):
        await storage.delete_many(["a.txt"], concurrency=0)


@_parametrize
async def test_signed_url_is_refused_without_the_capability(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """Neither provider can hand a browser a working URL, so both must say so."""
    assert storage.capabilities().public_urls is False

    await storage.write_text("a.txt", "x")
    with pytest.raises(CapabilityUnsupportedError):
        await storage.signed_url("a.txt")


# -- capabilities -----------------------------------------------------------


@_parametrize
async def test_declared_capabilities_match_reality(
    storage: AsyncBYOC, has_folders: bool
) -> None:
    """A declared capability must be backed by a working method."""
    caps = storage.capabilities()

    assert caps.folders is has_folders
    if caps.folders:
        created = await storage.create_folder("newdir/nested")
        assert created.type == "folder"
        assert await storage.exists("newdir/nested") is True
    else:
        with pytest.raises(CapabilityUnsupportedError):
            await storage.create_folder("newdir")

    if caps.server_side_copy:
        await storage.write_text("cap.txt", "x")
        await storage.copy("cap.txt", "cap-copy.txt")
        assert await storage.exists("cap-copy.txt") is True

    if caps.quota:
        assert (await storage.get_quota()).used >= 0


# -- safety -----------------------------------------------------------------


@_parametrize
@pytest.mark.parametrize(
    "attack",
    [
        "../escape.txt",
        "docs/../../escape.txt",
        "../../../../../../etc/byoc-escape",
        "docs/../../../escape.txt",
    ],
)
async def test_traversal_cannot_escape_the_root(
    storage: AsyncBYOC, has_folders: bool, attack: str
) -> None:
    with pytest.raises((InvalidInputError, PermissionDeniedError)):
        await storage.write_text(attack, "PWNED")


async def test_symlink_cannot_escape_the_local_root(tmp_path: Path) -> None:
    """Traversal filtering alone does not catch this: the path has no `..`."""
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("classified")
    (root / "backdoor").symlink_to(outside)

    client = AsyncBYOC(provider=LocalFileSystemProvider(root))
    await client.connect()
    try:
        with pytest.raises(PermissionDeniedError):
            await client.read_text("backdoor/secret.txt")
        with pytest.raises(PermissionDeniedError):
            await client.write_text("backdoor/planted.txt", "PWNED")
    finally:
        await client.disconnect()

    assert not (outside / "planted.txt").exists()


async def test_local_provider_never_writes_outside_its_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    client = AsyncBYOC(provider=LocalFileSystemProvider(root))
    await client.connect()
    try:
        await client.write_text("a/b/c.txt", "inside")
    finally:
        await client.disconnect()

    written = {p for p in tmp_path.rglob("*") if p.is_file()}
    assert written, "expected the file to be written"
    assert all(root in p.parents for p in written)


# -- provider-specific behaviour -------------------------------------------


async def test_memory_provider_helpers_expose_state() -> None:
    provider = MemoryProvider()
    client = AsyncBYOC(provider=provider)
    await client.connect()

    await client.write_text("a.txt", "one")
    await client.write_text("b.txt", "two")

    assert len(provider) == 2
    assert provider.snapshot() == {"a.txt": b"one", "b.txt": b"two"}

    provider.clear()
    assert len(provider) == 0
    assert await client.exists("a.txt") is False


async def test_an_empty_provider_still_registers() -> None:
    """Regression: the client used truthiness, so a provider defining
    ``__len__`` was silently dropped while empty."""
    provider = MemoryProvider()
    assert len(provider) == 0

    client = AsyncBYOC(provider=provider)

    assert client.manifest().id == "memory"


async def test_local_provider_hides_its_sidecar_store(tmp_path: Path) -> None:
    client = AsyncBYOC(provider=LocalFileSystemProvider(tmp_path))
    await client.connect()
    try:
        await client.upload("a.txt", b"x", UploadOptions(metadata={"k": "v"}))
        listed = {item.name for item in await client.list()}
    finally:
        await client.disconnect()

    assert "a.txt" in listed
    assert ".byoc" not in listed


async def test_local_provider_can_require_an_existing_root(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    provider = LocalFileSystemProvider(missing, create_root=False)

    with pytest.raises(InvalidInputError):
        await provider.connect()
