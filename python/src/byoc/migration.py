"""Transfer files between any two registered providers.

Mirrors the semantics of the TypeScript ``MigrationEngine``, including the
``partial`` outcome: if the copy to the target succeeded but the optional source
deletion failed, the transfer is done and only cleanup remains. Reporting that
as ``failed`` would make a caller re-upload bytes that are already there.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from .errors import InvalidInputError, ObjectAlreadyExistsError, StorageError
from .logging import BYOCLogger, SilentLogger
from .paths import normalize_virtual_path
from .types import BYOCProvider, ConflictStrategy, UploadOptions

FileStatus = Literal["migrated", "skipped", "failed", "partial"]


@dataclass(frozen=True, slots=True)
class MigrationFileResult:
    """Outcome for a single file.

    ``partial`` means the target copy exists but the source was not deleted.
    Callers retrying ``failed`` paths must not retry ``partial`` ones.
    """

    path: str
    status: FileStatus
    size: int | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class MigrationProgress:
    """Emitted after each file finishes, whatever its outcome."""

    current_file: str
    files_migrated: int
    files_total: int
    bytes_transferred: int
    percentage: int


@dataclass(frozen=True, slots=True)
class MigrationReport:
    """Summary of a completed migration."""

    source_provider: str
    target_provider: str
    files_total: int
    files_migrated: int
    files_skipped: int
    files_failed: int
    files_partial: int
    bytes_transferred: int
    results: list[MigrationFileResult] = field(default_factory=list)


ProgressCallback = Callable[[MigrationProgress], None]


async def migrate(
    *,
    source: BYOCProvider,
    target: BYOCProvider,
    paths: Sequence[str],
    conflict_strategy: ConflictStrategy = ConflictStrategy.OVERWRITE,
    concurrency: int = 4,
    delete_source_after_migrate: bool = False,
    on_progress: ProgressCallback | None = None,
    logger: BYOCLogger | None = None,
) -> MigrationReport:
    """Copy ``paths`` from ``source`` to ``target``.

    Args:
        conflict_strategy: What to do when the target already has the file.
        concurrency: How many files to transfer at once.
        delete_source_after_migrate: Delete each source file after a successful
            copy. A failure here yields ``partial``, never ``failed``.
    """
    log = logger or SilentLogger()

    if source is None or target is None:
        raise InvalidInputError(
            "Migration requires both 'source' and 'target' provider adapters.",
            provider="migration-engine",
        )

    clean_paths = [p for p in (normalize_virtual_path(path) for path in paths) if p]
    source_id = source.manifest().id
    target_id = target.manifest().id

    if not clean_paths:
        return MigrationReport(
            source_provider=source_id,
            target_provider=target_id,
            files_total=0,
            files_migrated=0,
            files_skipped=0,
            files_failed=0,
            files_partial=0,
            bytes_transferred=0,
            results=[],
        )

    results: list[MigrationFileResult] = []
    counts = {"migrated": 0, "skipped": 0, "failed": 0, "partial": 0}
    bytes_transferred = 0
    lock = asyncio.Lock()

    def emit(current_file: str) -> None:
        if on_progress is None:
            return
        finished = sum(counts.values())
        on_progress(
            MigrationProgress(
                current_file=current_file,
                files_migrated=counts["migrated"],
                files_total=len(clean_paths),
                bytes_transferred=bytes_transferred,
                percentage=round(finished / len(clean_paths) * 100),
            )
        )

    async def record(result: MigrationFileResult, transferred: int = 0) -> None:
        nonlocal bytes_transferred
        async with lock:
            counts[result.status] += 1
            bytes_transferred += transferred
            results.append(result)
            emit(result.path)

    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def transfer(path: str) -> None:
        async with semaphore:
            try:
                overwriting = conflict_strategy is ConflictStrategy.OVERWRITE
                if not overwriting and await target.exists(path):
                    if conflict_strategy is ConflictStrategy.SKIP:
                        await record(MigrationFileResult(path=path, status="skipped"))
                        return
                    raise ObjectAlreadyExistsError(
                        f'File already exists on target provider at path: "{path}"',
                        provider=target_id,
                    )

                output = await source.download(path)
                payload = await output.read()
                size = output.metadata.size if output.metadata.size is not None else len(payload)

                await target.upload(
                    path, payload, UploadOptions(mime_type=output.metadata.mime_type)
                )

                # The bytes are on the target now. Anything that fails past this
                # point is cleanup, not transfer, and must not read as failure.
                if delete_source_after_migrate:
                    try:
                        await source.delete(path)
                    except StorageError as exc:
                        await record(
                            MigrationFileResult(
                                path=path,
                                status="partial",
                                size=size,
                                error=f"Copied to target, but source deletion failed: {exc}",
                            ),
                            transferred=size,
                        )
                        return

                await record(
                    MigrationFileResult(path=path, status="migrated", size=size),
                    transferred=size,
                )

            except Exception as exc:
                await record(MigrationFileResult(path=path, status="failed", error=str(exc)))

    log.info("Starting migration from %s to %s (%d files)", source_id, target_id, len(clean_paths))
    await asyncio.gather(*(transfer(path) for path in clean_paths))

    return MigrationReport(
        source_provider=source_id,
        target_provider=target_id,
        files_total=len(clean_paths),
        files_migrated=counts["migrated"],
        files_skipped=counts["skipped"],
        files_failed=counts["failed"],
        files_partial=counts["partial"],
        bytes_transferred=bytes_transferred,
        results=results,
    )
