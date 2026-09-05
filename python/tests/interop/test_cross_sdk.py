"""Cross-SDK interop: the TypeScript and Python SDKs against the same servers.

This is the suite that justifies shipping both SDKs together. Friends will mix
them -- a Next.js frontend on ``@byoc/core`` and a FastAPI backend on ``byoc``,
both pointed at the same bucket. If a file written by one is not readable by the
other, that breaks silently in their projects, not here.

The TypeScript half runs through ``interop_cli.mjs``; both halves talk to the
same live MinIO and WebDAV servers.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from byoc.encryption import E2EECrypto
from byoc.providers.s3 import S3CompatibleProvider
from byoc.providers.webdav import WebDAVProvider

pytestmark = pytest.mark.interop

CLI = Path(__file__).parent / "interop_cli.mjs"
REPO_ROOT = Path(__file__).resolve().parents[3]

S3_ENDPOINT = os.environ.get("BYOC_TEST_S3_ENDPOINT", "http://127.0.0.1:9000")
S3_BUCKET = os.environ.get("BYOC_TEST_S3_BUCKET", "byoc-integration")
S3_REGION = os.environ.get("BYOC_TEST_S3_REGION", "us-east-1")
S3_KEY = os.environ.get("BYOC_TEST_S3_ACCESS_KEY", "minioadmin")
S3_SECRET = os.environ.get("BYOC_TEST_S3_SECRET_KEY", "minioadmin")

DAV_USER = os.environ.get("BYOC_TEST_WEBDAV_USERNAME", "byoc")
DAV_PASSWORD = os.environ.get("BYOC_TEST_WEBDAV_PASSWORD", "byoc-secret")

# The filenames that have historically broken one adapter or the other.
AWKWARD_FILENAMES = [
    "notes/draft#2.pdf",
    "notes/what?.txt",
    "Q3 report/a b.pdf",
    "docs/café/naïve.txt",
    "notes/Bob's Notes.pdf",
    "docs/a&b+c.txt",
]


def _node_available() -> bool:
    return shutil.which("node") is not None


def _ts_built() -> bool:
    return (REPO_ROOT / "packages" / "core" / "dist" / "index.js").exists()


def _s3_up() -> bool:
    try:
        httpx.get(f"{S3_ENDPOINT}/minio/health/live", timeout=2.0)
    except httpx.HTTPError:
        return False
    return True


requires_interop = pytest.mark.skipif(
    not (_node_available() and _ts_built() and _s3_up()),
    reason="Interop needs node, a built TypeScript dist/, and a live S3 server",
)
requires_node = pytest.mark.skipif(
    not (_node_available() and _ts_built()),
    reason="Interop needs node and a built TypeScript dist/",
)


@pytest.fixture(scope="module")
def dav_endpoint() -> Iterator[str]:
    """A WebDAV server both SDKs can reach, started locally unless configured."""
    external = os.environ.get("BYOC_TEST_WEBDAV_ENDPOINT")
    if external:
        yield external.rstrip("/")
        return

    from cheroot import wsgi
    from wsgidav.wsgidav_app import WsgiDAVApp

    root = tempfile.mkdtemp(prefix="byoc-interop-dav-")
    app = WsgiDAVApp(
        {
            "provider_mapping": {"/": root},
            "simple_dc": {"user_mapping": {"*": {DAV_USER: {"password": DAV_PASSWORD}}}},
            "http_authenticator": {"accept_basic": True, "accept_digest": False},
            "verbose": 0,
            "logging": {"enable": False},
        }
    )
    server = wsgi.Server(bind_addr=("127.0.0.1", 0), wsgi_app=app)
    server.prepare()
    port = server.bind_addr[1]
    threading.Thread(target=server.serve, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.stop()


def run_ts(command: str, args: dict[str, Any], dav_endpoint: str | None = None) -> dict[str, Any]:
    """Invoke the TypeScript SDK and return its JSON result."""
    env = {
        **os.environ,
        "BYOC_TEST_S3_ENDPOINT": S3_ENDPOINT,
        "BYOC_TEST_S3_BUCKET": S3_BUCKET,
        "BYOC_TEST_S3_REGION": S3_REGION,
        "BYOC_TEST_S3_ACCESS_KEY": S3_KEY,
        "BYOC_TEST_S3_SECRET_KEY": S3_SECRET,
        "BYOC_TEST_WEBDAV_USERNAME": DAV_USER,
        "BYOC_TEST_WEBDAV_PASSWORD": DAV_PASSWORD,
    }
    if dav_endpoint:
        env["BYOC_TEST_WEBDAV_ENDPOINT"] = dav_endpoint

    completed = subprocess.run(
        ["node", str(CLI), command, json.dumps(args)],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"TypeScript CLI '{command}' failed ({completed.returncode}): "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
    result: dict[str, Any] = json.loads(completed.stdout)
    return result


def py_s3(root_prefix: str) -> S3CompatibleProvider:
    return S3CompatibleProvider(
        endpoint=S3_ENDPOINT,
        bucket=S3_BUCKET,
        region=S3_REGION,
        access_key_id=S3_KEY,
        secret_access_key=S3_SECRET,
        root_prefix=root_prefix,
        force_path_style=True,
    )


def py_dav(endpoint: str, root_folder: str) -> WebDAVProvider:
    return WebDAVProvider(
        endpoint=endpoint, username=DAV_USER, password=DAV_PASSWORD, root_folder=root_folder
    )


# -- S3 ----------------------------------------------------------------------


@requires_interop
async def test_s3_typescript_writes_python_reads() -> None:
    root = f"interop-{uuid.uuid4().hex[:8]}"
    files = {name: f"content of {name}" for name in AWKWARD_FILENAMES}

    run_ts("write", {"backend": "s3", "root": root, "files": files})

    provider = py_s3(root)
    try:
        for name, expected in files.items():
            assert await (await provider.download(name)).text() == expected
    finally:
        await provider.disconnect()


@requires_interop
async def test_s3_python_writes_typescript_reads() -> None:
    root = f"interop-{uuid.uuid4().hex[:8]}"
    files = {name: f"content of {name}" for name in AWKWARD_FILENAMES}

    provider = py_s3(root)
    try:
        for name, content in files.items():
            await provider.upload(name, content, None)
    finally:
        await provider.disconnect()

    result = run_ts("read", {"backend": "s3", "root": root, "paths": list(files)})
    assert result["contents"] == files


@requires_interop
async def test_s3_listing_agrees_across_sdks() -> None:
    """Both SDKs must report the same virtual paths, names, and types."""
    root = f"interop-{uuid.uuid4().hex[:8]}"
    files = {"docs/a.txt": "a", "docs/b.txt": "bb", "docs/nested/c.txt": "ccc"}
    run_ts("write", {"backend": "s3", "root": root, "files": files})

    ts_listing = run_ts("list", {"backend": "s3", "root": root, "path": "docs"})["objects"]

    provider = py_s3(root)
    try:
        py_objects = sorted(
            (
                {"path": o.path, "name": o.name, "type": o.type, "size": o.size}
                for o in await provider.list("docs")
            ),
            key=lambda o: str(o["path"]),
        )
    finally:
        await provider.disconnect()

    assert [o["path"] for o in py_objects] == [o["path"] for o in ts_listing]
    assert [o["type"] for o in py_objects] == [o["type"] for o in ts_listing]


# -- WebDAV ------------------------------------------------------------------


@requires_interop
async def test_webdav_typescript_writes_python_reads(dav_endpoint: str) -> None:
    root = f"interop-{uuid.uuid4().hex[:8]}"
    files = {name: f"content of {name}" for name in AWKWARD_FILENAMES}

    run_ts("write", {"backend": "webdav", "root": root, "files": files}, dav_endpoint)

    provider = py_dav(dav_endpoint, root)
    try:
        for name, expected in files.items():
            assert await (await provider.download(name)).text() == expected
    finally:
        await provider.disconnect()


@requires_interop
async def test_webdav_python_writes_typescript_reads(dav_endpoint: str) -> None:
    root = f"interop-{uuid.uuid4().hex[:8]}"
    files = {name: f"content of {name}" for name in AWKWARD_FILENAMES}

    provider = py_dav(dav_endpoint, root)
    try:
        await provider.connect()
        for name, content in files.items():
            await provider.upload(name, content, None)
    finally:
        await provider.disconnect()

    result = run_ts(
        "read", {"backend": "webdav", "root": root, "paths": list(files)}, dav_endpoint
    )
    assert result["contents"] == files


# -- Encryption --------------------------------------------------------------


@requires_node
def test_e2ee_typescript_encrypts_python_decrypts() -> None:
    """Without this, an encrypted file written by one SDK is lost to the other."""
    passphrase = "cross-sdk-interop-passphrase"
    plaintext = "Sensitive payload written by TypeScript."

    envelope_hex = run_ts("encrypt", {"passphrase": passphrase, "plaintext": plaintext})[
        "envelopeHex"
    ]
    envelope = bytes.fromhex(envelope_hex)

    assert envelope[:12] == b"BYOC_E2EE_V3"
    decrypted = E2EECrypto(passphrase=passphrase).decrypt_sync(envelope)
    assert decrypted.decode("utf-8") == plaintext


@requires_node
def test_e2ee_python_encrypts_typescript_decrypts() -> None:
    passphrase = "cross-sdk-interop-passphrase"
    plaintext = "Sensitive payload written by Python."

    envelope = E2EECrypto(passphrase=passphrase).encrypt_sync(plaintext)
    result = run_ts("decrypt", {"passphrase": passphrase, "envelopeHex": envelope.hex()})
    assert result["plaintext"] == plaintext


@requires_node
@pytest.mark.parametrize("iterations", [10_000, 100_000, 600_000, 2_000_000])
def test_e2ee_iteration_counts_interoperate(iterations: int) -> None:
    """The envelope carries its own work factor, so any valid count must cross."""
    passphrase = "iteration-interop"
    plaintext = f"encrypted with {iterations} iterations"

    envelope_hex = run_ts(
        "encrypt", {"passphrase": passphrase, "plaintext": plaintext, "iterations": iterations}
    )["envelopeHex"]

    envelope = bytes.fromhex(envelope_hex)
    assert int.from_bytes(envelope[12:16], "big") == iterations
    assert E2EECrypto(passphrase=passphrase).decrypt_sync(envelope).decode() == plaintext


@requires_node
def test_e2ee_wrong_passphrase_fails_the_same_way_across_sdks() -> None:
    envelope = E2EECrypto(passphrase="right").encrypt_sync("secret")
    with pytest.raises(AssertionError) as excinfo:
        run_ts("decrypt", {"passphrase": "wrong", "envelopeHex": envelope.hex()})
    assert "BYOC_AUTH_REQUIRED" in str(excinfo.value)


# -- Pure functions ----------------------------------------------------------


@requires_node
def test_path_normalization_agrees_across_sdks() -> None:
    """A disagreement here means the two SDKs write to different folders."""
    from byoc.paths import encode_path_segments, normalize_virtual_path

    paths = [
        *AWKWARD_FILENAMES,
        "users///123////avatar.jpg",
        "  /documents/report.pdf  ",
        "./users/./123/avatar.jpg",
        "users\\123\\avatar.jpg",
    ]
    ts_results = run_ts("normalize", {"paths": paths})["results"]

    for entry in ts_results:
        normalized = normalize_virtual_path(entry["input"])
        assert normalized == entry["normalized"], f"normalize disagreed on {entry['input']!r}"
        assert encode_path_segments(normalized) == entry["encoded"], (
            f"encode disagreed on {entry['input']!r}"
        )
