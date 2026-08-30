"""Conformance: the operation surface both SDKs must expose.

Pins which operations exist, not which bytes they write. The byte-level
fixtures cannot catch a missing method, because an adapter that lacks
``copy()`` still writes identical bytes for everything it does implement.
That gap is how the Python S3 and Google Drive adapters shipped 0.2.x
declaring ``server_side_copy=True`` with no ``copy()`` behind it.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import load_fixture

from byoc import AsyncBYOC, LocalFileSystemProvider, MemoryProvider
from byoc.providers.gdrive import GoogleDriveProvider
from byoc.providers.s3 import S3CompatibleProvider
from byoc.providers.webdav import WebDAVProvider
from byoc.types import BYOCProvider

FIXTURE = load_fixture("provider-operations.json")

# Constructed with placeholder credentials: nothing here performs I/O, and
# every assertion is about the shape of the adapter rather than its behaviour.
ADAPTERS: dict[str, BYOCProvider] = {
    "google-drive": GoogleDriveProvider(
        client_id="test.apps.googleusercontent.com",
        redirect_uri="http://localhost/callback",
    ),
    "s3-compatible": S3CompatibleProvider(
        endpoint="http://127.0.0.1:9000",
        bucket="test",
        region="us-east-1",
        access_key_id="key",
        secret_access_key="secret",
    ),
    "webdav": WebDAVProvider(
        endpoint="http://127.0.0.1:8080", username="user", password="pass"
    ),
    "local": LocalFileSystemProvider("/tmp/byoc-conformance-shape-only"),
    "memory": MemoryProvider(),
}

PROVIDER_SPECS: dict[str, Any] = {
    name: spec for name, spec in FIXTURE["providers"].items() if not name.startswith("$")
}


def _has(target: object, operation: str) -> bool:
    return callable(getattr(target, operation, None))


@pytest.mark.parametrize("operation", FIXTURE["client_operations"]["required"])
def test_client_exposes_every_required_operation(operation: str) -> None:
    """An adapter method the client does not expose is unreachable by callers."""
    client = AsyncBYOC(provider=MemoryProvider())

    assert _has(client, operation), (
        f"AsyncBYOC is missing the required operation '{operation}'. "
        "An operation implemented on adapters but absent from the client "
        "cannot be called by anyone."
    )


@pytest.mark.parametrize("provider_id", sorted(PROVIDER_SPECS))
@pytest.mark.parametrize("operation", FIXTURE["provider_operations"]["required"])
def test_every_adapter_implements_the_required_operations(
    provider_id: str, operation: str
) -> None:
    assert _has(ADAPTERS[provider_id], operation), (
        f"Adapter '{provider_id}' is missing required operation '{operation}'."
    )


@pytest.mark.parametrize("provider_id", sorted(PROVIDER_SPECS))
def test_adapter_operation_surface_matches_the_fixture(provider_id: str) -> None:
    """Catches an adapter drifting ahead of or behind its peer SDK."""
    adapter = ADAPTERS[provider_id]
    expected = set(PROVIDER_SPECS[provider_id]["operations"])
    optional = set(FIXTURE["provider_operations"]["optional"])

    actual = {operation for operation in optional if _has(adapter, operation)}

    assert actual == expected, (
        f"Adapter '{provider_id}' optional operations {sorted(actual)} do not match "
        f"the fixture's {sorted(expected)}. Either implement the missing operation "
        "or update spec/fixtures/provider-operations.json in both SDKs."
    )


@pytest.mark.parametrize("provider_id", sorted(PROVIDER_SPECS))
def test_declared_capabilities_match_the_fixture(provider_id: str) -> None:
    capabilities = ADAPTERS[provider_id].capabilities()

    for flag, expected in PROVIDER_SPECS[provider_id]["capabilities"].items():
        assert getattr(capabilities, flag) is expected, (
            f"Adapter '{provider_id}' declares {flag}={getattr(capabilities, flag)}, "
            f"but the cross-SDK fixture pins {expected}."
        )


@pytest.mark.parametrize("provider_id", sorted(PROVIDER_SPECS))
@pytest.mark.parametrize(
    "contract",
    FIXTURE["capability_contracts"]["contracts"],
    ids=lambda contract: str(contract["capability"]),
)
def test_a_declared_capability_is_backed_by_a_real_method(
    provider_id: str, contract: dict[str, str]
) -> None:
    """Declaring a capability without the method is a lie to feature detection."""
    adapter = ADAPTERS[provider_id]
    capability, operation = contract["capability"], contract["requires_operation"]

    if not getattr(adapter.capabilities(), capability):
        pytest.skip(f"{provider_id} does not declare {capability}")

    assert _has(adapter, operation), (
        f"Adapter '{provider_id}' declares {capability}=True but has no "
        f"'{operation}' method. Callers feature-detect on the capability and "
        "would hit an AttributeError instead of a clean CapabilityUnsupportedError."
    )
