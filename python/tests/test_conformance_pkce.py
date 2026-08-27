"""PKCE conformance against the shared vectors.

The first vector is RFC 7636 Appendix B, so this is an external check rather
than a snapshot of our own output. A mismatch means Google rejects one SDK's
OAuth flow while accepting the other's.
"""

from __future__ import annotations

import re
from typing import Any

import pytest
from conftest import load_fixture

from byoc.providers.gdrive import (
    generate_code_challenge,
    generate_code_verifier,
    generate_oauth_state,
)

_FX = load_fixture("pkce.json")
_CASES: list[dict[str, Any]] = _FX["cases"]
_RULES = _FX["verifier_rules"]

_UNRESERVED = re.compile(r"^[A-Za-z0-9\-._~]+$")


def test_rfc7636_appendix_b_vector() -> None:
    """The canonical published vector, checked explicitly."""
    vector = _FX["rfc7636_appendix_b"]
    assert generate_code_challenge(vector["code_verifier"]) == vector["code_challenge"]


@pytest.mark.parametrize("case", _CASES, ids=[c["code_verifier"][:24] for c in _CASES])
def test_code_challenge_matches_vector(case: dict[str, Any]) -> None:
    assert generate_code_challenge(case["code_verifier"]) == case["code_challenge"]


@pytest.mark.parametrize("case", _CASES, ids=[c["code_verifier"][:24] for c in _CASES])
def test_challenge_is_unpadded_base64url(case: dict[str, Any]) -> None:
    """base64url with '=' padding, '+' or '/' would be rejected by Google."""
    challenge = generate_code_challenge(case["code_verifier"])
    assert "=" not in challenge
    assert "+" not in challenge
    assert "/" not in challenge
    assert len(challenge) == 43  # SHA-256 is 32 bytes -> 43 base64url chars


@pytest.mark.parametrize("length", [43, 64, 100, 128])
def test_generated_verifiers_satisfy_the_rules(length: int) -> None:
    verifier = generate_code_verifier(length)
    assert len(verifier) == length
    assert _RULES["min_length"] <= len(verifier) <= _RULES["max_length"]
    assert _UNRESERVED.match(verifier)


@pytest.mark.parametrize(("requested", "expected"), [(1, 43), (10, 43), (500, 128)])
def test_verifier_length_is_clamped_to_the_rfc_range(requested: int, expected: int) -> None:
    assert len(generate_code_verifier(requested)) == expected


def test_verifiers_are_unpredictable() -> None:
    """A predictable verifier defeats the point of PKCE entirely."""
    generated = {generate_code_verifier(64) for _ in range(200)}
    assert len(generated) == 200


def test_oauth_state_is_random_and_sized() -> None:
    states = {generate_oauth_state(32) for _ in range(200)}
    assert len(states) == 200
    assert all(len(s) == 32 for s in states)
