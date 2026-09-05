"""E2EE conformance: this SDK against the shared cross-SDK envelope vectors.

Passing this suite is what makes a file encrypted by the TypeScript SDK readable
here, and vice versa.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import load_fixture

from byoc.encryption import (
    E2EE_MAGIC_HEADER_V3,
    E2EE_V3_HEADER_LENGTH,
    ITER_LENGTH,
    IV_LENGTH,
    MAGIC_LENGTH,
    SALT_LENGTH,
    TAG_LENGTH,
    E2EECrypto,
)
from byoc.errors import ERROR_CLASS_BY_CODE, BYOCErrorCode, StorageError

_FX = load_fixture("e2ee-envelope.json")
_VECTORS: list[dict[str, Any]] = _FX["vectors"]
_REJECTIONS: list[dict[str, Any]] = _FX["rejection_cases"]
_BOUNDS = _FX["iteration_bounds"]


def _v2_vector() -> dict[str, Any]:
    return next(v for v in _VECTORS if v["version"] == "V2")


@pytest.mark.parametrize("vec", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_derived_key_matches_vector(vec: dict[str, Any]) -> None:
    """Isolates PBKDF2 from AES-GCM, so a mismatch says which half is wrong."""
    crypto = E2EECrypto(passphrase=vec["passphrase"])
    derived = crypto._derive_key(bytes.fromhex(vec["salt_hex"]), vec["iterations"])
    assert derived.hex() == vec["derived_key_hex"]


@pytest.mark.parametrize("vec", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_decrypts_vector(vec: dict[str, Any]) -> None:
    crypto = E2EECrypto(passphrase=vec["passphrase"])
    plaintext = crypto.decrypt_sync(bytes.fromhex(vec["envelope_hex"]))
    assert plaintext.decode("utf-8") == vec["plaintext_utf8"]


@pytest.mark.parametrize("vec", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_envelope_framing_matches_spec(vec: dict[str, Any]) -> None:
    """Correct plaintext with a wrong byte layout would still break the peer SDK."""
    env = bytes.fromhex(vec["envelope_hex"])
    offset = 0

    assert env[offset : offset + MAGIC_LENGTH] == f"BYOC_E2EE_{vec['version']}".encode()
    offset += MAGIC_LENGTH

    if vec["version"] in {"V2", "V3"}:
        assert int.from_bytes(env[offset : offset + ITER_LENGTH], "big") == vec["iterations"]
        offset += ITER_LENGTH

    if vec["version"] == "V3":
        assert int.from_bytes(env[offset : offset + 4], "big") == vec["frame_size"]
        offset += 4

    assert env[offset : offset + SALT_LENGTH].hex() == vec["salt_hex"]
    offset += SALT_LENGTH

    if vec["version"] == "V3":
        assert env[offset : offset + 8].hex() == vec["nonce_base_hex"]
        offset += 8
        assert int.from_bytes(env[offset : offset + 4], "big") == len(
            bytes.fromhex(vec["ciphertext_hex"])
        )
        offset += 4
        assert env[offset : offset + TAG_LENGTH].hex() == vec["tag_hex"]
        offset += TAG_LENGTH
        assert env[offset:].hex() == vec["ciphertext_hex"]
        return

    assert env[offset : offset + IV_LENGTH].hex() == vec["iv_hex"]
    offset += IV_LENGTH
    assert env[offset : offset + TAG_LENGTH].hex() == vec["tag_hex"]
    offset += TAG_LENGTH
    assert env[offset:].hex() == vec["ciphertext_hex"]


def test_encrypt_produces_a_spec_conformant_envelope() -> None:
    crypto = E2EECrypto(passphrase="spec-conformance-passphrase")
    envelope = crypto.encrypt_sync("round trip")

    assert envelope[:MAGIC_LENGTH] == E2EE_MAGIC_HEADER_V3
    iterations = int.from_bytes(envelope[MAGIC_LENGTH : MAGIC_LENGTH + ITER_LENGTH], "big")
    assert _BOUNDS["min"] <= iterations <= _BOUNDS["max"]
    assert int.from_bytes(envelope[16:20], "big") == 256 * 1024
    assert crypto.decrypt_sync(envelope).decode("utf-8") == "round trip"


@pytest.mark.parametrize("case", _REJECTIONS, ids=[c["name"] for c in _REJECTIONS])
def test_rejection_cases(case: dict[str, Any]) -> None:
    vec = _v2_vector()
    env = bytearray(bytes.fromhex(vec["envelope_hex"]))

    mutate = case.get("mutate")
    if mutate:
        offset = mutate["offset"]
        if "uint32_be" in mutate:
            env[offset : offset + 4] = int(mutate["uint32_be"]).to_bytes(4, "big")
        if "ascii" in mutate:
            raw = mutate["ascii"].encode()
            env[offset : offset + len(raw)] = raw

    if case.get("truncate_to") is not None:
        env = env[: case["truncate_to"]]

    crypto = E2EECrypto(passphrase=case.get("passphrase", vec["passphrase"]))
    expected_code = BYOCErrorCode(case["expect_error"])

    started = time.monotonic()
    with pytest.raises(StorageError) as excinfo:
        crypto.decrypt_sync(bytes(env))

    assert excinfo.value.code == expected_code
    assert isinstance(excinfo.value, ERROR_CLASS_BY_CODE[expected_code])
    # An out-of-range work factor must be refused before any key derivation runs.
    assert time.monotonic() - started < 2.0


async def test_async_api_round_trips() -> None:
    crypto = E2EECrypto(passphrase="async-passphrase")
    envelope = await crypto.encrypt("async payload")
    assert (await crypto.decrypt(envelope)).decode("utf-8") == "async payload"


async def test_streaming_round_trip_crosses_hostile_chunk_boundaries() -> None:
    crypto = E2EECrypto(
        passphrase="streaming-passphrase",
        key_derivation_iterations=10_000,
        frame_size=4096,
    )
    plaintext = b"stream-boundary-check-" * 700

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, len(plaintext), 733):
            yield plaintext[offset : offset + 733]

    encrypted = b"".join([chunk async for chunk in crypto.encrypt_stream(source())])

    async def hostile_transport() -> AsyncIterator[bytes]:
        for offset in range(0, len(encrypted), 97):
            yield encrypted[offset : offset + 97]

    decrypted = b"".join([chunk async for chunk in crypto.decrypt_stream(hostile_transport())])
    assert decrypted == plaintext


def test_v3_empty_payload_has_one_authenticated_frame() -> None:
    crypto = E2EECrypto(passphrase="empty", key_derivation_iterations=10_000)
    envelope = crypto.encrypt_sync(b"")
    assert len(envelope) == E2EE_V3_HEADER_LENGTH + 4 + TAG_LENGTH
    assert crypto.decrypt_sync(envelope) == b""


def test_v3_rejects_removed_reordered_and_oversized_frames() -> None:
    crypto = E2EECrypto(
        passphrase="tamper-test",
        key_derivation_iterations=10_000,
        frame_size=4096,
    )
    envelope = crypto.encrypt_sync(b"Z" * 9000)
    record_size = 4 + TAG_LENGTH + 4096
    header = envelope[:E2EE_V3_HEADER_LENGTH]
    first = envelope[E2EE_V3_HEADER_LENGTH : E2EE_V3_HEADER_LENGTH + record_size]
    second = envelope[
        E2EE_V3_HEADER_LENGTH + record_size : E2EE_V3_HEADER_LENGTH + record_size * 2
    ]
    final = envelope[E2EE_V3_HEADER_LENGTH + record_size * 2 :]

    with pytest.raises(StorageError) as truncated:
        crypto.decrypt_sync(header + first + second)
    assert truncated.value.code == BYOCErrorCode.AUTH_REQUIRED

    with pytest.raises(StorageError) as reordered:
        crypto.decrypt_sync(header + second + first + final)
    assert reordered.value.code == BYOCErrorCode.AUTH_REQUIRED

    oversized = bytearray(envelope)
    oversized[E2EE_V3_HEADER_LENGTH : E2EE_V3_HEADER_LENGTH + 4] = (0xFFFFFFFF).to_bytes(
        4, "big"
    )
    with pytest.raises(StorageError) as too_large:
        crypto.decrypt_sync(bytes(oversized))
    assert too_large.value.code == BYOCErrorCode.CORRUPTED_DATA

    invalid_frame_size = bytearray(envelope)
    invalid_frame_size[16:20] = (16).to_bytes(4, "big")
    with pytest.raises(StorageError) as bad_header:
        crypto.decrypt_sync(bytes(invalid_frame_size))
    assert bad_header.value.code == BYOCErrorCode.CORRUPTED_DATA


def test_rejects_out_of_range_construction() -> None:
    for iterations in (0, 100, 10_000.5):
        with pytest.raises(StorageError) as excinfo:
            E2EECrypto(passphrase="p", key_derivation_iterations=iterations)  # type: ignore[arg-type]
        assert excinfo.value.code == BYOCErrorCode.INVALID_INPUT

    with pytest.raises(StorageError) as excinfo:
        E2EECrypto(passphrase="p", frame_size=4096.5)  # type: ignore[arg-type]
    assert excinfo.value.code == BYOCErrorCode.INVALID_INPUT


def test_calculates_exact_framed_envelope_sizes() -> None:
    crypto = E2EECrypto(passphrase="p", frame_size=4096)

    assert crypto.encrypted_size(0) == 64
    assert crypto.encrypted_size(4096) == 4160
    assert crypto.encrypted_size(4097) == 4181
    with pytest.raises(StorageError):
        crypto.encrypted_size(-1)
    with pytest.raises(StorageError):
        crypto.encrypted_size(0x100000000 * 4096 + 1)
