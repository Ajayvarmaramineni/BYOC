"""OAuth session types and token storage backends."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from ...encryption import E2EECrypto
from ...errors import StorageError

# Refresh slightly early so a token cannot expire between the check and the call.
EXPIRY_SKEW_SECONDS = 60


@dataclass(frozen=True, slots=True)
class TokenSession:
    """An OAuth session. ``refresh_token`` is the long-lived secret."""

    access_token: str
    refresh_token: str | None = None
    expires_at: float | None = None
    token_type: str = "Bearer"
    scope: str | None = None

    @property
    def is_expired(self) -> bool:
        """Whether the access token is expired or about to be."""
        if self.expires_at is None:
            return False
        return time.time() >= self.expires_at - EXPIRY_SKEW_SECONDS

    def to_dict(self) -> dict[str, object]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "token_type": self.token_type,
            "scope": self.scope,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> TokenSession:
        return cls(
            access_token=str(raw["access_token"]),
            refresh_token=str(raw["refresh_token"]) if raw.get("refresh_token") else None,
            expires_at=float(raw["expires_at"]) if raw.get("expires_at") else None,  # type: ignore[arg-type]
            token_type=str(raw.get("token_type") or "Bearer"),
            scope=str(raw["scope"]) if raw.get("scope") else None,
        )

    def with_access_token(self, access_token: str, expires_at: float | None) -> TokenSession:
        return replace(self, access_token=access_token, expires_at=expires_at)


class TokenStorage(Protocol):
    """Where refresh tokens live between calls."""

    def get(self) -> TokenSession | None: ...
    def set(self, session: TokenSession) -> None: ...
    def clear(self) -> None: ...


class InMemoryTokenStorage:
    """Default storage. Sessions are lost on restart, so the user re-consents.

    Fine for scripts and tests; use :class:`EncryptedFileTokenStorage` for a
    long-running service.
    """

    def __init__(self, session: TokenSession | None = None) -> None:
        self._session = session

    def get(self) -> TokenSession | None:
        return self._session

    def set(self, session: TokenSession) -> None:
        self._session = session

    def clear(self) -> None:
        self._session = None


class EncryptedFileTokenStorage:
    """Persists a session to disk, encrypted with AES-256-GCM.

    A refresh token grants long-lived access to the user's Drive, so it is never
    written in plaintext. The file is also created with owner-only permissions.

    Args:
        file_path: Where to store the encrypted session.
        encryption_key: Passphrase used to derive the encryption key.
    """

    def __init__(self, file_path: str | Path, encryption_key: str) -> None:
        self._path = Path(file_path)
        self._crypto = E2EECrypto(passphrase=encryption_key)

    def get(self) -> TokenSession | None:
        if not self._path.exists():
            return None
        try:
            payload = self._crypto.decrypt_sync(self._path.read_bytes())
        except StorageError:
            # A corrupt file, or one written under a different encryption key,
            # is unreadable either way. Both mean the same thing to the caller:
            # there is no usable session, so re-authenticate.
            return None
        raw: dict[str, object] = json.loads(payload.decode("utf-8"))
        return TokenSession.from_dict(raw)

    def set(self, session: TokenSession) -> None:
        envelope = self._crypto.encrypt_sync(json.dumps(session.to_dict()).encode("utf-8"))
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Create with 0600 before writing, so the token is never briefly
        # world-readable on a shared machine.
        descriptor = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(envelope)

    def clear(self) -> None:
        self._path.unlink(missing_ok=True)
