"""Google Drive resumable streaming: the Content-Range protocol.

Drive accepts ``bytes {start}-{end}/*`` while the total is unknown and requires
the real total on the final chunk. A chunk therefore cannot be classified until
we know whether more data follows, which is why the uploader keeps a one-chunk
lookahead. These tests pin the exact header sequence, because getting it wrong
fails at the *end* of a large upload rather than the start.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

import httpx
import pytest

from byoc.providers.gdrive._http import DriveHttpClient

ALIGN = 256 * 1024
RANGE_RE = re.compile(r"^bytes (?:(\d+)-(\d+)|\*)/(\d+|\*)$")


class _FakeOAuth:
    async def get_access_token(self) -> str:
        return "token"


def _drive_transport(seen: list[tuple[str, int]]) -> httpx.MockTransport:
    """A Drive that records Content-Range and enforces the protocol."""
    received = bytearray()

    def handle(request: httpx.Request) -> httpx.Response:
        raw = request.headers.get("content-range", "")
        match = RANGE_RE.match(raw)
        assert match, f"malformed Content-Range: {raw!r}"

        start, end, total = match.group(1), match.group(2), match.group(3)
        body = request.content
        seen.append((raw, len(body)))

        if start is not None:
            assert int(start) == len(received), "chunks must be contiguous"
            assert int(end) - int(start) + 1 == len(body), "range must match body"
            if total == "*":
                assert len(body) % ALIGN == 0, "a non-final chunk must be 256 KiB aligned"
            received.extend(body)

        if total == "*":
            return httpx.Response(308, headers={"Range": f"bytes=0-{len(received) - 1}"})

        assert int(total) == len(received), "final chunk must declare the real total"
        return httpx.Response(
            200,
            content=json.dumps(
                {"id": "f1", "name": "s.bin", "size": str(len(received))}
            ).encode(),
            headers={"content-type": "application/json"},
        )

    return httpx.MockTransport(handle)


async def _stream(total: int, seen: list[tuple[str, int]]) -> dict[str, object]:
    client = DriveHttpClient(_FakeOAuth())  # type: ignore[arg-type]
    client._client = httpx.AsyncClient(transport=_drive_transport(seen))

    async def source() -> AsyncIterator[bytes]:
        step = 100_000  # deliberately not chunk-aligned
        for offset in range(0, total, step):
            yield b"d" * min(step, total - offset)

    return await client.stream_chunks("https://upload/session", source(), chunk_size=ALIGN)


@pytest.mark.parametrize(
    ("total", "expected_chunks"),
    [
        (0, 1),                 # empty object still needs one finalising request
        (1, 1),
        (ALIGN - 1, 1),
        (ALIGN, 1),             # exactly one chunk is final, never sent as "*"
        (ALIGN * 2, 2),
        (ALIGN * 2 + 1, 3),
        (ALIGN * 7 + 12345, 8),
    ],
)
async def test_chunk_count_matches_the_payload_shape(
    total: int, expected_chunks: int
) -> None:
    seen: list[tuple[str, int]] = []

    resource = await _stream(total, seen)

    assert resource["id"] == "f1"
    assert len(seen) == expected_chunks


async def test_only_the_last_chunk_declares_a_total() -> None:
    """Every earlier chunk must say `*`, or Drive rejects the upload."""
    seen: list[tuple[str, int]] = []

    await _stream(ALIGN * 3 + 99, seen)

    ranges = [header for header, _ in seen]
    assert all(header.endswith("/*") for header in ranges[:-1]), ranges
    assert ranges[-1].endswith(f"/{ALIGN * 3 + 99}"), ranges[-1]


async def test_a_single_full_chunk_is_sent_as_final_not_as_unknown() -> None:
    """The lookahead exists for this case.

    A payload of exactly one chunk fills the buffer, and a naive implementation
    ships it as non-final and then has nothing left to finalise with.
    """
    seen: list[tuple[str, int]] = []

    await _stream(ALIGN, seen)

    assert len(seen) == 1
    assert seen[0][0] == f"bytes 0-{ALIGN - 1}/{ALIGN}"


async def test_an_empty_stream_finalises_without_a_byte_range() -> None:
    seen: list[tuple[str, int]] = []

    await _stream(0, seen)

    assert seen == [("bytes */0", 0)]


async def test_offsets_are_contiguous_across_chunks() -> None:
    seen: list[tuple[str, int]] = []

    await _stream(ALIGN * 4 + 7, seen)

    offset = 0
    for header, length in seen:
        assert header.startswith(f"bytes {offset}-"), header
        offset += length
    assert offset == ALIGN * 4 + 7
