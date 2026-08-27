"""PKCE (RFC 7636) helpers for the Google Drive OAuth flow.

PKCE is what stops an intercepted authorization code from being redeemed by an
attacker, so the verifier must come from a cryptographically secure RNG -- never
``random``. Behaviour is pinned by ``spec/fixtures/pkce.json``, whose first
vector is RFC 7636 Appendix B.
"""

from __future__ import annotations

import base64
import hashlib
import secrets

from ...errors import InvalidInputError

MIN_VERIFIER_LENGTH = 43
MAX_VERIFIER_LENGTH = 128

# RFC 7636 section 4.1: verifiers use the unreserved character set.
_VERIFIER_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
)


def _base64url(raw: bytes) -> str:
    """Base64url-encode without padding, per RFC 7636."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def generate_code_verifier(length: int = 64) -> str:
    """Generate a cryptographically random ``code_verifier``.

    Args:
        length: Desired length, clamped to the RFC's 43..128 range.
    """
    size = max(MIN_VERIFIER_LENGTH, min(MAX_VERIFIER_LENGTH, length))
    return "".join(secrets.choice(_VERIFIER_ALPHABET) for _ in range(size))


def generate_code_challenge(verifier: str) -> str:
    """Derive the S256 ``code_challenge`` from a verifier.

    The challenge is the base64url-encoded SHA-256 of the ASCII verifier.
    """
    if not verifier:
        raise InvalidInputError("PKCE code_verifier must not be empty.", provider="google-drive")
    return _base64url(hashlib.sha256(verifier.encode("ascii")).digest())


def generate_oauth_state(length: int = 32) -> str:
    """Generate a random ``state`` value for CSRF protection.

    The caller must store this and compare it against the value returned on the
    redirect; skipping that check leaves the flow open to CSRF.
    """
    return secrets.token_urlsafe(max(16, length))[:length]
