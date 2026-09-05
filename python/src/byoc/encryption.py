"""Versioned, cross-SDK client-side encryption for BYOC objects.

V3 authenticates independently sized frames so large files can be encrypted and
decrypted with bounded memory. V1 and V2 remain readable forever; the bytes in
``spec/fixtures/e2ee-envelope.json`` are the language-neutral wire contract.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterable, AsyncIterator, Iterable
from typing import cast

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .errors import AuthRequiredError, CorruptedDataError, InvalidInputError

E2EE_MAGIC_HEADER_V1 = b"BYOC_E2EE_V1"
E2EE_MAGIC_HEADER_V2 = b"BYOC_E2EE_V2"
E2EE_MAGIC_HEADER_V3 = b"BYOC_E2EE_V3"
MAGIC_LENGTH = 12
ITER_LENGTH = 4
SALT_LENGTH = 16
IV_LENGTH = 12
TAG_LENGTH = 16
NONCE_BASE_LENGTH = 8
FRAME_LENGTH_FIELD = 4

HEADER_LENGTH_V1 = MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH
HEADER_LENGTH_V2 = MAGIC_LENGTH + ITER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH
E2EE_V3_HEADER_LENGTH = 44

V1_FIXED_ITERATIONS = 100_000
DEFAULT_ITERATIONS = 600_000
MIN_ITERATIONS = 10_000
MAX_ITERATIONS = 2_000_000

E2EE_V3_DEFAULT_FRAME_SIZE = 256 * 1024
E2EE_V3_MIN_FRAME_SIZE = 4 * 1024
E2EE_V3_MAX_FRAME_SIZE = 8 * 1024 * 1024

ByteSource = AsyncIterable[bytes] | Iterable[bytes]


class E2EECrypto:
    """Encrypt and decrypt BYOC envelopes with AES-256-GCM.

    New writes use V3 framing. A random per-file salt derives the AES key with
    PBKDF2-HMAC-SHA256; a random nonce base plus the frame index gives each frame
    a unique nonce. The full header, index, and final-frame marker are AAD.
    """

    def __init__(
        self,
        *,
        passphrase: str | None = None,
        master_key: bytes | None = None,
        key_derivation_iterations: int = DEFAULT_ITERATIONS,
        frame_size: int = E2EE_V3_DEFAULT_FRAME_SIZE,
    ) -> None:
        if passphrase is None and master_key is None:
            raise InvalidInputError(
                "E2EECrypto requires either a 'passphrase' or 'master_key'.", provider="core"
            )
        if (
            type(key_derivation_iterations) is not int
            or not MIN_ITERATIONS <= key_derivation_iterations <= MAX_ITERATIONS
        ):
            raise InvalidInputError(
                f"E2EECrypto 'key_derivation_iterations' must be between {MIN_ITERATIONS} "
                f"and {MAX_ITERATIONS} (received {key_derivation_iterations}).",
                provider="core",
            )
        if (
            type(frame_size) is not int
            or not E2EE_V3_MIN_FRAME_SIZE <= frame_size <= E2EE_V3_MAX_FRAME_SIZE
        ):
            raise InvalidInputError(
                f"E2EECrypto 'frame_size' must be between {E2EE_V3_MIN_FRAME_SIZE} and "
                f"{E2EE_V3_MAX_FRAME_SIZE} bytes (received {frame_size}).",
                provider="core",
            )

        self.iterations = key_derivation_iterations
        self.frame_size = frame_size
        self._master_key = (
            bytes(master_key) if master_key is not None else passphrase.encode("utf-8")  # type: ignore[union-attr]
        )

    def encrypted_size(self, plaintext_size: int) -> int:
        """Return the exact V3 envelope size for a plaintext byte length."""
        if type(plaintext_size) is not int or plaintext_size < 0:
            raise InvalidInputError(
                f"E2EE plaintext size must be a non-negative integer (received {plaintext_size}).",
                provider="core",
            )
        frame_count = max(1, (plaintext_size + self.frame_size - 1) // self.frame_size)
        if frame_count > 0x100000000:
            raise InvalidInputError(
                "E2EE plaintext exceeds the V3 frame-counter capacity.", provider="core"
            )
        return E2EE_V3_HEADER_LENGTH + plaintext_size + frame_count * (
            FRAME_LENGTH_FIELD + TAG_LENGTH
        )

    def _derive_key(self, salt: bytes, iterations: int) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", self._master_key, salt, iterations, dklen=32)

    @staticmethod
    def _validate_iterations(iterations: int) -> None:
        if not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
            raise CorruptedDataError(
                f"Invalid E2EE payload: iteration count {iterations} is outside the accepted "
                f"range ({MIN_ITERATIONS}-{MAX_ITERATIONS}).",
                provider="core",
            )

    @staticmethod
    def _frame_nonce(nonce_base: bytes, index: int) -> bytes:
        if index > 0xFFFFFFFF:
            raise CorruptedDataError("E2EE V3 frame counter exhausted.", provider="core")
        return nonce_base + index.to_bytes(4, "big")

    @staticmethod
    def _frame_aad(header: bytes, index: int, is_final: bool) -> bytes:
        return header + index.to_bytes(4, "big") + bytes([1 if is_final else 0])

    def _build_v3_header(self, salt: bytes, nonce_base: bytes) -> bytes:
        return (
            E2EE_MAGIC_HEADER_V3
            + self.iterations.to_bytes(ITER_LENGTH, "big")
            + self.frame_size.to_bytes(FRAME_LENGTH_FIELD, "big")
            + salt
            + nonce_base
        )

    def _encrypt_frame(
        self,
        plaintext: bytes,
        *,
        index: int,
        is_final: bool,
        key: bytes,
        nonce_base: bytes,
        header: bytes,
    ) -> bytes:
        sealed = AESGCM(key).encrypt(
            self._frame_nonce(nonce_base, index),
            plaintext,
            self._frame_aad(header, index, is_final),
        )
        ciphertext, tag = sealed[:-TAG_LENGTH], sealed[-TAG_LENGTH:]
        return len(ciphertext).to_bytes(FRAME_LENGTH_FIELD, "big") + tag + ciphertext

    def _decrypt_frame(
        self,
        tag: bytes,
        ciphertext: bytes,
        *,
        index: int,
        is_final: bool,
        key: bytes,
        nonce_base: bytes,
        header: bytes,
    ) -> bytes:
        try:
            return AESGCM(key).decrypt(
                self._frame_nonce(nonce_base, index),
                ciphertext + tag,
                self._frame_aad(header, index, is_final),
            )
        except InvalidTag as exc:
            raise AuthRequiredError(
                "E2EE Decryption failed: Invalid passphrase or corrupted ciphertext.",
                provider="core",
            ) from exc

    def encrypt_sync(self, plaintext: bytes | str) -> bytes:
        """Encrypt a buffered value into a V3 envelope."""
        data = plaintext.encode("utf-8") if isinstance(plaintext, str) else bytes(plaintext)
        salt = os.urandom(SALT_LENGTH)
        nonce_base = os.urandom(NONCE_BASE_LENGTH)
        header = self._build_v3_header(salt, nonce_base)
        key = self._derive_key(salt, self.iterations)
        output = bytearray(header)

        if not data:
            output.extend(
                self._encrypt_frame(
                    b"", index=0, is_final=True, key=key, nonce_base=nonce_base, header=header
                )
            )
            return bytes(output)

        for index, offset in enumerate(range(0, len(data), self.frame_size)):
            frame = data[offset : offset + self.frame_size]
            output.extend(
                self._encrypt_frame(
                    frame,
                    index=index,
                    is_final=offset + len(frame) == len(data),
                    key=key,
                    nonce_base=nonce_base,
                    header=header,
                )
            )
        return bytes(output)

    def decrypt_sync(self, envelope: bytes) -> bytes:
        """Decrypt V1, V2, or V3 buffered envelopes."""
        buf = bytes(envelope)
        if buf[:MAGIC_LENGTH] == E2EE_MAGIC_HEADER_V3:
            return self._decrypt_v3_sync(buf)
        return self._decrypt_legacy_sync(buf)

    def _decrypt_v3_sync(self, buf: bytes) -> bytes:
        if len(buf) < E2EE_V3_HEADER_LENGTH:
            raise CorruptedDataError("Invalid E2EE payload: Truncated envelope.", provider="core")

        header = buf[:E2EE_V3_HEADER_LENGTH]
        iterations = int.from_bytes(header[12:16], "big")
        frame_size = int.from_bytes(header[16:20], "big")
        self._validate_iterations(iterations)
        if not E2EE_V3_MIN_FRAME_SIZE <= frame_size <= E2EE_V3_MAX_FRAME_SIZE:
            raise CorruptedDataError(
                f"Invalid E2EE V3 payload: frame size {frame_size} is outside the accepted "
                f"range ({E2EE_V3_MIN_FRAME_SIZE}-{E2EE_V3_MAX_FRAME_SIZE}).",
                provider="core",
            )

        salt = header[20:36]
        nonce_base = header[36:E2EE_V3_HEADER_LENGTH]
        key = self._derive_key(salt, iterations)
        offset = E2EE_V3_HEADER_LENGTH
        index = 0
        plaintext = bytearray()

        if offset == len(buf):
            raise CorruptedDataError(
                "Invalid E2EE V3 payload: Missing authenticated final frame.", provider="core"
            )

        while offset < len(buf):
            if len(buf) - offset < FRAME_LENGTH_FIELD:
                raise CorruptedDataError(
                    "Invalid E2EE payload: Truncated envelope.", provider="core"
                )
            frame_length = int.from_bytes(buf[offset : offset + FRAME_LENGTH_FIELD], "big")
            offset += FRAME_LENGTH_FIELD
            if frame_length > frame_size:
                raise CorruptedDataError(
                    f"Invalid E2EE V3 payload: frame length {frame_length} exceeds declared "
                    f"frame size {frame_size}.",
                    provider="core",
                )
            if len(buf) - offset < TAG_LENGTH + frame_length:
                raise CorruptedDataError(
                    "Invalid E2EE payload: Truncated envelope.", provider="core"
                )
            tag = buf[offset : offset + TAG_LENGTH]
            offset += TAG_LENGTH
            ciphertext = buf[offset : offset + frame_length]
            offset += frame_length
            plaintext.extend(
                self._decrypt_frame(
                    tag,
                    ciphertext,
                    index=index,
                    is_final=offset == len(buf),
                    key=key,
                    nonce_base=nonce_base,
                    header=header,
                )
            )
            index += 1

        return bytes(plaintext)

    def _decrypt_legacy_sync(self, buf: bytes) -> bytes:
        if len(buf) < HEADER_LENGTH_V1:
            raise CorruptedDataError(
                "Invalid E2EE payload: Data is shorter than header size.", provider="core"
            )

        magic = buf[:MAGIC_LENGTH]
        is_v2 = magic == E2EE_MAGIC_HEADER_V2
        is_v1 = magic == E2EE_MAGIC_HEADER_V1
        if not is_v2 and not is_v1:
            raise CorruptedDataError(
                "Invalid E2EE payload: Missing or unrecognized magic header.", provider="core"
            )

        offset = MAGIC_LENGTH
        if is_v2:
            if len(buf) < HEADER_LENGTH_V2:
                raise CorruptedDataError(
                    "Invalid E2EE V2 payload: Data is shorter than header size.", provider="core"
                )
            iter_field = buf[offset : offset + ITER_LENGTH]
            file_iterations = int.from_bytes(iter_field, "big")
            self._validate_iterations(file_iterations)
            offset += ITER_LENGTH
            salt = buf[offset : offset + SALT_LENGTH]
            aad = E2EE_MAGIC_HEADER_V2 + iter_field + salt
        else:
            file_iterations = V1_FIXED_ITERATIONS
            salt = buf[offset : offset + SALT_LENGTH]
            aad = E2EE_MAGIC_HEADER_V1 + salt

        offset += SALT_LENGTH
        iv = buf[offset : offset + IV_LENGTH]
        offset += IV_LENGTH
        tag = buf[offset : offset + TAG_LENGTH]
        offset += TAG_LENGTH
        ciphertext = buf[offset:]

        try:
            key = self._derive_key(salt, file_iterations)
            return AESGCM(key).decrypt(iv, ciphertext + tag, aad)
        except InvalidTag as exc:
            raise AuthRequiredError(
                "E2EE Decryption failed: Invalid passphrase or corrupted ciphertext.",
                provider="core",
            ) from exc

    async def encrypt(self, plaintext: bytes | str) -> bytes:
        """Encrypt a buffered value off the event loop."""
        return await asyncio.to_thread(self.encrypt_sync, plaintext)

    async def decrypt(self, envelope: bytes) -> bytes:
        """Decrypt a buffered V1, V2, or V3 envelope off the event loop."""
        return await asyncio.to_thread(self.decrypt_sync, envelope)

    async def encrypt_stream(self, source: ByteSource) -> AsyncIterator[bytes]:
        """Encrypt an arbitrary byte stream while retaining at most one frame."""
        salt = os.urandom(SALT_LENGTH)
        nonce_base = os.urandom(NONCE_BASE_LENGTH)
        header = self._build_v3_header(salt, nonce_base)
        key = await asyncio.to_thread(self._derive_key, salt, self.iterations)
        yield header

        pending: bytes | None = None
        index = 0
        async for frame in _frame_source(source, self.frame_size):
            if pending is not None:
                yield self._encrypt_frame(
                    pending,
                    index=index,
                    is_final=False,
                    key=key,
                    nonce_base=nonce_base,
                    header=header,
                )
                index += 1
            pending = frame

        yield self._encrypt_frame(
            pending or b"",
            index=index,
            is_final=True,
            key=key,
            nonce_base=nonce_base,
            header=header,
        )

    async def decrypt_stream(self, source: ByteSource) -> AsyncIterator[bytes]:
        """Decrypt V3 incrementally; legacy envelopes fall back to buffered reading."""
        reader = _AsyncByteReader(source)
        magic = cast(bytes, await reader.read_exactly(MAGIC_LENGTH))

        if magic != E2EE_MAGIC_HEADER_V3:
            envelope = magic + await reader.read_remaining()
            yield await asyncio.to_thread(self._decrypt_legacy_sync, envelope)
            return

        tail = cast(
            bytes, await reader.read_exactly(E2EE_V3_HEADER_LENGTH - MAGIC_LENGTH)
        )
        header = magic + tail
        iterations = int.from_bytes(header[12:16], "big")
        frame_size = int.from_bytes(header[16:20], "big")
        self._validate_iterations(iterations)
        if not E2EE_V3_MIN_FRAME_SIZE <= frame_size <= E2EE_V3_MAX_FRAME_SIZE:
            raise CorruptedDataError(
                f"Invalid E2EE V3 payload: frame size {frame_size} is outside the accepted "
                f"range ({E2EE_V3_MIN_FRAME_SIZE}-{E2EE_V3_MAX_FRAME_SIZE}).",
                provider="core",
            )

        salt = header[20:36]
        nonce_base = header[36:E2EE_V3_HEADER_LENGTH]
        key = await asyncio.to_thread(self._derive_key, salt, iterations)

        length_field = await reader.read_exactly(FRAME_LENGTH_FIELD, allow_eof=True)
        if length_field is None:
            raise CorruptedDataError(
                "Invalid E2EE V3 payload: Missing authenticated final frame.", provider="core"
            )

        index = 0
        tag, ciphertext = await self._read_stream_frame(reader, length_field, frame_size)
        while True:
            next_length = await reader.read_exactly(FRAME_LENGTH_FIELD, allow_eof=True)
            is_final = next_length is None
            yield self._decrypt_frame(
                tag,
                ciphertext,
                index=index,
                is_final=is_final,
                key=key,
                nonce_base=nonce_base,
                header=header,
            )
            if next_length is None:
                return
            index += 1
            tag, ciphertext = await self._read_stream_frame(reader, next_length, frame_size)

    async def _read_stream_frame(
        self, reader: _AsyncByteReader, length_field: bytes, frame_size: int
    ) -> tuple[bytes, bytes]:
        frame_length = int.from_bytes(length_field, "big")
        if frame_length > frame_size:
            raise CorruptedDataError(
                f"Invalid E2EE V3 payload: frame length {frame_length} exceeds declared "
                f"frame size {frame_size}.",
                provider="core",
            )
        tag = cast(bytes, await reader.read_exactly(TAG_LENGTH))
        ciphertext = cast(bytes, await reader.read_exactly(frame_length))
        return tag, ciphertext


async def _iterate(source: ByteSource) -> AsyncIterator[bytes]:
    if isinstance(source, AsyncIterable):
        async for chunk in source:
            yield bytes(chunk)
    else:
        for chunk in source:
            yield bytes(chunk)


async def _frame_source(source: ByteSource, frame_size: int) -> AsyncIterator[bytes]:
    frame = bytearray(frame_size)
    used = 0
    async for chunk in _iterate(source):
        offset = 0
        while offset < len(chunk):
            take = min(frame_size - used, len(chunk) - offset)
            frame[used : used + take] = chunk[offset : offset + take]
            used += take
            offset += take
            if used == frame_size:
                yield bytes(frame)
                frame = bytearray(frame_size)
                used = 0
    if used:
        yield bytes(frame[:used])


class _AsyncByteReader:
    def __init__(self, source: ByteSource) -> None:
        self._iterator = _iterate(source).__aiter__()
        self._buffer = bytearray()
        self._ended = False

    async def read_exactly(self, length: int, *, allow_eof: bool = False) -> bytes | None:
        while len(self._buffer) < length and not self._ended:
            try:
                chunk = await anext(self._iterator)
            except StopAsyncIteration:
                self._ended = True
                break
            self._buffer.extend(chunk)

        if allow_eof and self._ended and not self._buffer:
            return None
        if len(self._buffer) < length:
            raise CorruptedDataError("Invalid E2EE payload: Truncated envelope.", provider="core")

        result = bytes(self._buffer[:length])
        del self._buffer[:length]
        return result

    async def read_remaining(self) -> bytes:
        output = bytearray(self._buffer)
        self._buffer.clear()
        while not self._ended:
            try:
                output.extend(await anext(self._iterator))
            except StopAsyncIteration:
                self._ended = True
        return bytes(output)
