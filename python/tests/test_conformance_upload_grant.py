"""Conformance: the UploadGrant wire format.

A grant is minted by a server in one language and consumed by a browser client
in another, so its JSON key names are a cross-SDK contract in the same way the
E2EE envelope's byte layout is. The flagship case -- a FastAPI backend with a
React frontend -- crosses this boundary on every upload.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from conftest import load_fixture

from byoc import AsyncBYOC, MemoryProvider, UploadGrant, UploadGrantOptions
from byoc.errors import CapabilityUnsupportedError
from byoc.providers.s3 import S3CompatibleProvider

FIXTURE = load_fixture("upload-grant.json")

ACCESS_KEY = "AKIAEXAMPLEKEYID0000"
SECRET_KEY = "SuperSecretValueThatMustNeverAppearAnywhere"


def make_s3() -> S3CompatibleProvider:
    return S3CompatibleProvider(
        endpoint="https://example.r2.cloudflarestorage.com",
        bucket="user-assets",
        region="auto",
        access_key_id=ACCESS_KEY,
        secret_access_key=SECRET_KEY,
    )


@pytest.fixture
async def grant() -> UploadGrant:
    client = AsyncBYOC(provider=make_s3())
    return await client.create_upload_grant(
        "photos/holiday.jpg", UploadGrantOptions(expires_in_seconds=300)
    )


async def test_wire_form_carries_every_required_key(grant: UploadGrant) -> None:
    payload = grant.to_dict()

    for key in FIXTURE["wire_keys"]["required"]:
        assert key in payload, f"grant is missing required wire key '{key}'"


async def test_wire_form_uses_no_unknown_keys(grant: UploadGrant) -> None:
    allowed = set(FIXTURE["wire_keys"]["required"]) | set(FIXTURE["wire_keys"]["optional"])

    assert set(grant.to_dict()) <= allowed


async def test_absent_optionals_are_omitted_not_null(grant: UploadGrant) -> None:
    """Regression: a null ``maxBytes`` made the browser client reject everything.

    ``size > null`` coerces null to 0 in JavaScript and evaluates true, so every
    upload failed the size check with "allows at most null".
    """
    payload = grant.to_dict()

    assert FIXTURE["absent_optionals"]["rule"] == "omit"
    assert "maxBytes" not in payload
    assert "chunkSize" not in payload
    assert None not in payload.values()


async def test_wire_form_survives_a_json_round_trip(grant: UploadGrant) -> None:
    revived = json.loads(json.dumps(grant.to_dict()))

    assert revived["path"] == grant.path
    assert revived["url"] == grant.url
    # The timestamp must be parseable by a JavaScript Date, i.e. ISO 8601.
    assert datetime.fromisoformat(revived["expiresAt"]).tzinfo is not None


async def test_method_and_protocol_are_within_the_declared_enums(
    grant: UploadGrant,
) -> None:
    assert grant.method in FIXTURE["enums"]["method"]
    assert grant.protocol in FIXTURE["enums"]["protocol"]


async def test_the_url_never_carries_the_secret_key(grant: UploadGrant) -> None:
    """The access key id in X-Amz-Credential is expected; the secret is not.

    MinIO's defaults use the same string for both, so a substring check against
    a live MinIO reports a false leak. These credentials are deliberately
    distinct so the assertion means something.
    """
    assert SECRET_KEY not in grant.url
    assert ACCESS_KEY in grant.url, "SigV4 puts the key id in X-Amz-Credential"


async def test_signed_headers_stay_empty(grant: UploadGrant) -> None:
    """Every signed header is one the browser must reproduce byte-for-byte."""
    assert grant.headers == FIXTURE["field_rules"]["headers"]["prefer"]


async def test_s3_binds_the_path_into_the_signature() -> None:
    """A client must not be able to redirect a grant to another path."""
    client = AsyncBYOC(provider=make_s3())

    one = await client.create_upload_grant("photos/a.jpg")
    two = await client.create_upload_grant("photos/b.jpg")

    sig_one = one.url.split("X-Amz-Signature=")[1]
    sig_two = two.url.split("X-Amz-Signature=")[1]
    assert sig_one != sig_two, "signature must cover the object key"


async def test_expiry_is_in_the_future_and_bounded() -> None:
    client = AsyncBYOC(provider=make_s3())
    before = datetime.now(timezone.utc)

    grant = await client.create_upload_grant(
        "a.jpg", UploadGrantOptions(expires_in_seconds=300)
    )

    assert grant.expires_at is not None
    assert grant.expires_at > before
    assert grant.expires_at <= before + timedelta(seconds=301)


async def test_a_provider_without_the_capability_refuses() -> None:
    client = AsyncBYOC(provider=MemoryProvider())

    assert client.capabilities().direct_upload is False
    with pytest.raises(CapabilityUnsupportedError):
        await client.create_upload_grant("a.jpg")


@pytest.mark.parametrize(
    "provider_id", sorted(FIXTURE["providers_without_direct_upload"])
)
def test_the_fixture_and_the_adapters_agree_on_who_cannot(provider_id: str) -> None:
    """Each provider the fixture excludes must actually declare it false."""
    from byoc import LocalFileSystemProvider
    from byoc.providers.webdav import WebDAVProvider

    adapters = {
        "webdav": WebDAVProvider(
            endpoint="http://127.0.0.1:8080", username="u", password="p"
        ),
        "local": LocalFileSystemProvider("/tmp/byoc-shape-only"),
        "memory": MemoryProvider(),
    }

    assert adapters[provider_id].capabilities().direct_upload is False
