"""Client-side end-to-end encryption.

The envelope written here is a binary format stored in the user's own cloud and
read back by any BYOC SDK in any language, so its layout is cross-SDK contract.
It is pinned by ``spec/fixtures/e2ee-envelope.json``::

    V2:  MAGIC(12) | ITER(4) | SALT(16) | IV(12) | TAG(16) | CIPHERTEXT(n)
    V1:  MAGIC(12) |          SALT(16) | IV(12) | TAG(16) | CIPHERTEXT(n)

Cipher is AES-256-GCM; the key is PBKDF2-HMAC-SHA256(passphrase, salt,
iterations, dklen=32). The magic header, iteration field and salt are bound as
GCM additional authenticated data, so the header cannot be edited undetected.
"""

from __future__ import annotations

import asyncio
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .errors import AuthRequiredError, CorruptedDataError, InvalidInputError

E2EE_MAGIC_HEADER_V1 = b"BYOC_E2EE_V1"  # legacy v0.1 format, fixed 100k iterations
E2EE_MAGIC_HEADER_V2 = b"BYOC_E2EE_V2"  # v0.2 format, 4-byte iteration field
MAGIC_LENGTH = 12
ITER_LENGTH = 4
SALT_LENGTH = 16
IV_LENGTH = 12
TAG_LENGTH = 16

HEADER_LENGTH_V1 = MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH
HEADER_LENGTH_V2 = MAGIC_LENGTH + ITER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH

V1_FIXED_ITERATIONS = 100_000
DEFAULT_ITERATIONS = 600_000

# Accepted bounds for the envelope-encoded PBKDF2 iteration count.
#
# The iteration count is read from untrusted storage and consumed *before* the
# GCM tag can authenticate it, so it must be range-checked first: a hostile
# 4-byte edit would otherwise turn a ~50 ms decrypt into minutes of PBKDF2
# occupying a worker thread. The floor rejects envelopes whose key derivation is
# too weak to trust; the ceiling caps the work an attacker can force.
MIN_ITERATIONS = 10_000
MAX_ITERATIONS = 2_000_000


class E2EECrypto:
    """Encrypts and decrypts payloads with AES-256-GCM and a PBKDF2-derived key.

    Args:
        passphrase: User passphrase to derive the key from.
        master_key: Raw key material, as an alternative to ``passphrase``.
        key_derivation_iterations: PBKDF2 iteration count for *new* envelopes.
            Must fall within ``MIN_ITERATIONS``..``MAX_ITERATIONS``. Decryption
            always honours the count recorded in the file being read, so raising
            this never orphans existing data.
    """

    def __init__(
        self,
        *,
        passphrase: str | None = None,
        master_key: bytes | None = None,
        key_derivation_iterations: int = DEFAULT_ITERATIONS,
    ) -> None:
        if passphrase is None and master_key is None:
            raise InvalidInputError(
                "E2EECrypto requires either a 'passphrase' or 'master_key'.", provider="core"
            )

        if not MIN_ITERATIONS <= key_derivation_iterations <= MAX_ITERATIONS:
            raise InvalidInputError(
                f"E2EECrypto 'key_derivation_iterations' must be between {MIN_ITERATIONS} "
                f"and {MAX_ITERATIONS} (received {key_derivation_iterations}).",
                provider="core",
            )

        self.iterations = key_derivation_iterations
        self._master_key = (
            bytes(master_key) if master_key is not None else passphrase.encode("utf-8")  # type: ignore[union-attr]
        )

    def _derive_key(self, salt: bytes, iterations: int) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", self._master_key, salt, iterations, dklen=32)

    def encrypt_sync(self, plaintext: bytes | str) -> bytes:
        """Encrypt to a V2 envelope. Blocking; prefer :meth:`encrypt` in async code."""
        data = plaintext.encode("utf-8") if isinstance(plaintext, str) else bytes(plaintext)
        salt = os.urandom(SALT_LENGTH)
        iv = os.urandom(IV_LENGTH)
        iter_field = self.iterations.to_bytes(ITER_LENGTH, "big")

        key = self._derive_key(salt, self.iterations)
        aad = E2EE_MAGIC_HEADER_V2 + iter_field + salt

        # AESGCM.encrypt returns ciphertext || tag; the envelope stores the tag
        # ahead of the ciphertext, so split them apart.
        sealed = AESGCM(key).encrypt(iv, data, aad)
        ciphertext, tag = sealed[:-TAG_LENGTH], sealed[-TAG_LENGTH:]

        return E2EE_MAGIC_HEADER_V2 + iter_field + salt + iv + tag + ciphertext

    def decrypt_sync(self, envelope: bytes) -> bytes:
        """Decrypt a V1 or V2 envelope. Blocking; prefer :meth:`decrypt` in async code."""
        buf = bytes(envelope)

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

            # Range-check before deriving: this value comes from untrusted
            # storage and is consumed before the GCM tag can authenticate it.
            if not MIN_ITERATIONS <= file_iterations <= MAX_ITERATIONS:
                raise CorruptedDataError(
                    f"Invalid E2EE payload: iteration count {file_iterations} is outside the "
                    f"accepted range ({MIN_ITERATIONS}-{MAX_ITERATIONS}).",
                    provider="core",
                )

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
        """Encrypt to a V2 envelope, deriving the key off the event loop."""
        return await asyncio.to_thread(self.encrypt_sync, plaintext)

    async def decrypt(self, envelope: bytes) -> bytes:
        """Decrypt a V1 or V2 envelope, deriving the key off the event loop."""
        return await asyncio.to_thread(self.decrypt_sync, envelope)
