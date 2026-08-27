"""SigV4 conformance: this SDK against the shared cross-SDK vectors.

If these pass, the Python adapter can authenticate to the same S3/R2/MinIO
endpoints the TypeScript adapter can.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import pytest
from conftest import load_fixture

from byoc.providers._sigv4 import (
    EMPTY_BODY_SHA256,
    build_canonical_query_string,
    create_presigned_s3_url,
    sign_s3_request,
)

_FX = load_fixture("sigv4.json")
_CRED = _FX["credentials"]
_MOMENT = datetime.fromisoformat(_FX["datetime_iso"].replace("Z", "+00:00"))
_QUERY_CASES: list[dict[str, Any]] = _FX["canonical_query"]
_VECTORS: list[dict[str, Any]] = _FX["vectors"]
_PRESIGNED: list[dict[str, Any]] = _FX["presigned"]


def test_empty_body_hash_matches_spec() -> None:
    assert _FX["empty_body_sha256"] == EMPTY_BODY_SHA256


@pytest.mark.parametrize("case", _QUERY_CASES, ids=[c["url"] for c in _QUERY_CASES])
def test_canonical_query_string(case: dict[str, Any]) -> None:
    query = urlsplit(case["url"]).query
    assert build_canonical_query_string(query) == case["expected"]


@pytest.mark.parametrize("vec", _VECTORS, ids=[v["name"] for v in _VECTORS])
def test_signature_matches_vector(vec: dict[str, Any]) -> None:
    body = vec["body"].encode("utf-8") if vec["body"] is not None else None
    signed = sign_s3_request(
        access_key_id=_CRED["access_key_id"],
        secret_access_key=_CRED["secret_access_key"],
        region=_CRED["region"],
        service=_CRED["service"],
        method=vec["method"],
        url=vec["url"],
        headers=vec["headers"],
        body=body,
        moment=_MOMENT,
    )

    assert signed["Authorization"] == vec["authorization"]

    match = re.search(r"Signature=([0-9a-f]+)", signed["Authorization"])
    assert match is not None
    assert match.group(1) == vec["signature"]

    signed_headers = re.search(r"SignedHeaders=([^,]+)", signed["Authorization"])
    assert signed_headers is not None
    assert signed_headers.group(1) == vec["signed_headers"]


def test_header_casing_does_not_change_the_signature() -> None:
    """A caller passing 'Content-Type' must sign identically to 'content-type'."""
    common = {
        "access_key_id": _CRED["access_key_id"],
        "secret_access_key": _CRED["secret_access_key"],
        "region": _CRED["region"],
        "method": "PUT",
        "url": "https://examplebucket.s3.amazonaws.com/k.txt",
        "body": b"x",
        "moment": _MOMENT,
    }
    upper = sign_s3_request(**common, headers={"Content-Type": "text/plain"})  # type: ignore[arg-type]
    lower = sign_s3_request(**common, headers={"content-type": "text/plain"})  # type: ignore[arg-type]

    assert upper["Authorization"] == lower["Authorization"]
    # The header must also go on the wire in the form that was signed.
    assert "content-type" in upper
    assert "Content-Type" not in upper


@pytest.mark.parametrize("case", _PRESIGNED, ids=[c["name"] for c in _PRESIGNED])
def test_presigned_url_matches_vector(case: dict[str, Any]) -> None:
    url = create_presigned_s3_url(
        access_key_id=_CRED["access_key_id"],
        secret_access_key=_CRED["secret_access_key"],
        region=_CRED["region"],
        service=_CRED["service"],
        url=case["url"],
        method=case["method"],
        expires_in_seconds=case["expires_in_seconds"],
        moment=_MOMENT,
    )
    assert url == case["expected_url"]
