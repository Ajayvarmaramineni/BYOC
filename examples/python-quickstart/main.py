#!/usr/bin/env python3
"""BYOC Python quickstart.

Mirrors examples/node-quickstart, so the two SDKs can be compared side by side.

Runs entirely offline by default: it registers all three providers, inspects
capabilities, switches between them, and demonstrates client-side encryption
without contacting any server.

Point it at a real S3 server to exercise a live round-trip::

    brew install minio
    minio server /tmp/byoc-minio-data --address :9000

    BYOC_DEMO_S3=1 python main.py
"""

from __future__ import annotations

import asyncio
import os

from byoc import AsyncBYOC, E2EECrypto, LocalFileSystemProvider, MemoryProvider
from byoc.providers.gdrive import (
    GoogleDriveProvider,
    generate_code_challenge,
    generate_code_verifier,
    generate_oauth_state,
)
from byoc.providers.s3 import S3CompatibleProvider
from byoc.providers.webdav import WebDAVProvider

S3_ENDPOINT = os.environ.get("BYOC_TEST_S3_ENDPOINT", "http://127.0.0.1:9000")
S3_BUCKET = os.environ.get("BYOC_TEST_S3_BUCKET", "byoc-integration")


def build_providers() -> list[object]:
    """Construct one adapter per ownership model.

    Credentials are placeholders: nothing here contacts a provider until a
    storage call is actually made.
    """
    return [
        # No account, no network, no credentials.
        LocalFileSystemProvider("./byoc-demo-storage"),
        GoogleDriveProvider(
            client_id="your-client-id.apps.googleusercontent.com",
            redirect_uri="http://localhost:8765/callback",
            root_folder_name="MyApplication",
        ),
        S3CompatibleProvider(
            endpoint=S3_ENDPOINT,
            bucket=S3_BUCKET,
            region="auto",
            access_key_id=os.environ.get("BYOC_TEST_S3_ACCESS_KEY", "minioadmin"),
            secret_access_key=os.environ.get("BYOC_TEST_S3_SECRET_KEY", "minioadmin"),
            force_path_style=True,
        ),
        WebDAVProvider(
            endpoint="https://nextcloud.example.com/remote.php/dav/files/alex/",
            username="alex",
            password="an-app-password",
        ),
    ]


async def main() -> None:
    print("=== BYOC (Bring Your Own Cloud) Python quickstart ===\n")

    # 0. A real round trip, with no account and no network. Everything below
    #    this block uses placeholder credentials and only demonstrates shapes;
    #    this part genuinely reads and writes.
    print("0. Real storage round trip, no credentials required:")
    scratch = AsyncBYOC(provider=MemoryProvider())
    async with scratch:
        await scratch.write_text("reports/q3.md", "# Q3 results")
        await scratch.copy("reports/q3.md", "reports/q3-backup.md")
        print(f"   read back:  {await scratch.read_text('reports/q3-backup.md')!r}")

        walked = [item.path async for item in scratch.walk("reports")]
        print(f"   walk:       {', '.join(walked)}")

        removed = await scratch.delete_tree("reports")
        print(f"   delete_tree: removed {len(removed.deleted)}, failed {len(removed.failed)}")
    print("   Swap MemoryProvider for LocalFileSystemProvider and it writes real files.\n")

    # 1. PKCE, the handshake that protects the OAuth authorization code.
    verifier = generate_code_verifier(64)
    print("1. PKCE security handshake:")
    print(f"   Code challenge: {generate_code_challenge(verifier)}")
    print(f"   State:          {generate_oauth_state(32)}\n")

    storage = AsyncBYOC(providers=build_providers(), default_provider_id="google-drive")  # type: ignore[arg-type]

    # 2. One client, several ownership models.
    print("2. Registered storage providers:")
    for manifest in storage.get_providers():
        print(f"   [{manifest.category.upper()}] {manifest.name} (id: {manifest.id})")
    print()

    # 3. Capabilities are declared, so callers feature-detect instead of guessing.
    print("3. Capabilities differ per provider, and BYOC reports them honestly:")
    for provider_id in ("google-drive", "s3-compatible", "webdav", "local"):
        caps = storage.use_provider(provider_id).capabilities()
        print(
            f"   {provider_id:16} folders={caps.folders!s:5} "
            f"quota={caps.quota!s:5} resumable={caps.resumable_uploads}"
        )
    print()

    # 4. Switching backends changes nothing about the calling code.
    print("4. Runtime provider switching:")
    for provider_id in ("s3-compatible", "webdav", "local", "google-drive"):
        storage.use_provider(provider_id)
        print(f"   active: {storage.manifest().name}")
    print()

    # 5. Client-side encryption, so the storage operator never sees plaintext.
    print("5. Client-side end-to-end encryption:")
    crypto = E2EECrypto(passphrase="correct-horse-battery-staple")
    envelope = await crypto.encrypt("Sensitive patient record")
    print(f"   envelope:  {bytes(envelope[:12]).decode()} + {len(envelope)} bytes total")
    print(f"   plaintext: {(await crypto.decrypt(envelope)).decode()}")
    print("   The same envelope is readable by the TypeScript SDK.\n")

    # 6. Optional live round-trip against a real S3 server.
    if os.environ.get("BYOC_DEMO_S3"):
        print(f"6. Live round-trip against {S3_ENDPOINT}:")
        storage.use_provider("s3-compatible")
        await storage.connect()
        try:
            obj = await storage.write_text("quickstart/hello.md", "# Hello from BYOC!")
            print(f"   wrote:  {obj.path} ({obj.size} bytes)")
            print(f"   read:   {await storage.read_text('quickstart/hello.md')!r}")
            await storage.delete("quickstart/hello.md")
            print(f"   exists after delete: {await storage.exists('quickstart/hello.md')}")
        finally:
            await storage.disconnect()
    else:
        print("6. Set BYOC_DEMO_S3=1 with a MinIO server running for a live round-trip.")

    print("\nReady to store files in storage the end user already owns.")


if __name__ == "__main__":
    asyncio.run(main())
