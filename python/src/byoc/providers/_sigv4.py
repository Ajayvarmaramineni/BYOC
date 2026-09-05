"""AWS Signature Version 4 request signing.

Used by the S3-compatible adapter for AWS S3, Cloudflare R2, MinIO, and Wasabi.
Behaviour is pinned by ``spec/fixtures/sigv4.json``; the first vector there was
verified against a clean-room implementation written from the AWS specification,
so these are an external check rather than a snapshot of our own output.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from ..paths import rfc3986_uri_encode

ALGORITHM = "AWS4-HMAC-SHA256"
EMPTY_BODY_SHA256 = hashlib.sha256(b"").hexdigest()
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

_WHITESPACE_RUN = re.compile(r"\s+")


def _sha256_hex(data: bytes | memoryview) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret_access_key: str, date_stamp: str, region: str, service: str) -> bytes:
    k_date = _hmac(f"AWS4{secret_access_key}".encode(), date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def build_canonical_query_string(query: str) -> str:
    """Build the SigV4 canonical query string.

    Each key and value is RFC 3986 encoded (slashes included), then pairs are
    sorted by encoded key and, on ties, by encoded value.

    A ``+`` in a raw query string decodes to a space and must re-encode as
    ``%20``; emitting ``+`` produces a signature AWS will reject.
    """
    pairs = [
        (rfc3986_uri_encode(key, True), rfc3986_uri_encode(value, True))
        for key, value in parse_qsl(query, keep_blank_values=True)
    ]
    pairs.sort()
    return "&".join(f"{key}={value}" for key, value in pairs)


def _normalize_headers(headers: dict[str, str] | None) -> dict[str, str]:
    """Lowercase keys and trim/collapse whitespace in values.

    Signing a header under a different case than it is sent produces a
    signature mismatch, so normalization must happen before both.
    """
    normalized: dict[str, str] = {}
    for key, value in (headers or {}).items():
        normalized[key.lower().strip()] = _WHITESPACE_RUN.sub(" ", value.strip())
    return normalized


def _amz_date(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sign_s3_request(
    *,
    access_key_id: str,
    secret_access_key: str,
    region: str,
    method: str,
    url: str,
    service: str = "s3",
    headers: dict[str, str] | None = None,
    body: bytes | memoryview | None = None,
    moment: datetime | None = None,
    unsigned_payload: bool = False,
) -> dict[str, str]:
    """Sign a request and return the headers to send, including ``Authorization``.

    The returned mapping is what must go on the wire: sending a header that was
    not signed, or with different casing, invalidates the signature.
    """
    now = moment or datetime.now(timezone.utc)
    amz_date = _amz_date(now)
    date_stamp = amz_date[:8]

    parts = urlsplit(url)
    canonical_uri = parts.path or "/"
    canonical_query = build_canonical_query_string(parts.query)

    # Streaming bodies cannot be hashed without buffering them, which is the
    # whole point of streaming, so they sign as UNSIGNED-PAYLOAD instead. The
    # request is still authenticated and TLS still protects the body in
    # transit; only the body's integrity is no longer covered by the signature.
    # Buffered uploads keep signing the real hash, so nothing regresses.
    if unsigned_payload:
        body_hash = UNSIGNED_PAYLOAD
    else:
        # An empty body signs as the sha256 of the empty string, not UNSIGNED-PAYLOAD.
        body_hash = _sha256_hex(body) if body else EMPTY_BODY_SHA256

    signed = {
        "host": parts.netloc,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": body_hash,
        **_normalize_headers(headers),
    }

    sorted_keys = sorted(signed)
    canonical_headers = "".join(f"{key}:{signed[key]}\n" for key in sorted_keys)
    signed_headers = ";".join(sorted_keys)

    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            body_hash,
        ]
    )

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [ALGORITHM, amz_date, credential_scope, _sha256_hex(canonical_request.encode("utf-8"))]
    )

    key = _signing_key(secret_access_key, date_stamp, region, service)
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"{ALGORITHM} Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {**signed, "Authorization": authorization}


def create_presigned_s3_url(
    *,
    access_key_id: str,
    secret_access_key: str,
    region: str,
    url: str,
    service: str = "s3",
    method: str = "GET",
    expires_in_seconds: int = 3600,
    moment: datetime | None = None,
) -> str:
    """Create a query-authenticated presigned URL.

    Presigned URLs sign ``UNSIGNED-PAYLOAD`` and only the ``host`` header, since
    the body is not known when the URL is created.
    """
    now = moment or datetime.now(timezone.utc)
    amz_date = _amz_date(now)
    date_stamp = amz_date[:8]
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"

    parts = urlsplit(url)
    query_pairs = parse_qsl(parts.query, keep_blank_values=True)
    query_pairs += [
        ("X-Amz-Algorithm", ALGORITHM),
        ("X-Amz-Credential", f"{access_key_id}/{credential_scope}"),
        ("X-Amz-Date", amz_date),
        ("X-Amz-Expires", str(expires_in_seconds)),
        ("X-Amz-SignedHeaders", "host"),
    ]
    query = "&".join(
        f"{rfc3986_uri_encode(k, True)}={rfc3986_uri_encode(v, True)}"
        for k, v in query_pairs
    )

    canonical_request = "\n".join(
        [
            method.upper(),
            parts.path or "/",
            build_canonical_query_string(query),
            f"host:{parts.netloc}\n",
            "host",
            UNSIGNED_PAYLOAD,
        ]
    )
    string_to_sign = "\n".join(
        [ALGORITHM, amz_date, credential_scope, _sha256_hex(canonical_request.encode("utf-8"))]
    )
    key = _signing_key(secret_access_key, date_stamp, region, service)
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, f"{query}&X-Amz-Signature={signature}", "")
    )
