#!/usr/bin/env python3
"""Manual live validation for the Google Drive adapter.

Drive cannot be covered in CI: it needs a real Google account and a browser
consent step. This script is the substitute -- run it once before releasing, and
after any change to the Drive adapter, OAuth flow, or path resolver.

Setup
-----
1. Google Cloud console -> create a project -> enable the **Google Drive API**.
2. APIs & Services -> OAuth consent screen -> External -> add yourself as a
   test user. No verification is needed: BYOC uses the non-restricted
   ``drive.file`` scope.
3. Credentials -> Create OAuth client ID -> **Desktop app**.
4. Export the client id (and secret, for a Desktop client)::

       export BYOC_GDRIVE_CLIENT_ID="...apps.googleusercontent.com"
       export BYOC_GDRIVE_CLIENT_SECRET="..."

Then run::

    python scripts/validate_gdrive_live.py

It opens a consent page, writes and reads real files in a throwaway folder in
your Drive, and cleans up after itself.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from byoc import AsyncBYOC
from byoc.providers.gdrive import (
    GoogleDriveProvider,
    generate_code_challenge,
    generate_code_verifier,
    generate_oauth_state,
)

AUTH_TIMEOUT_SECONDS = 180
REDIRECT_PORT = 8765
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"

AWKWARD_FILENAMES = [
    "notes/Bob's Notes.pdf",
    "notes/draft#2.pdf",
    "notes/what?.txt",
    "docs/café/naïve.txt",
    "Q3 report/a b.pdf",
]

_received: dict[str, str] = {}


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        params = parse_qs(urlparse(self.path).query)
        _received.update({k: v[0] for k, v in params.items()})
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h2>BYOC: authorization received. You can close this tab.</h2>")

    def log_message(self, *args: object) -> None:
        pass  # keep the console readable


def _authorize(provider: GoogleDriveProvider, verifier: str, state: str) -> str:
    url = provider.oauth.get_authorization_url(
        state=state, code_challenge=generate_code_challenge(verifier), redirect_uri=REDIRECT_URI
    )
    try:
        server = HTTPServer(("localhost", REDIRECT_PORT), _CallbackHandler)
    except OSError as exc:
        # Almost always an earlier run of this script that never exited.
        raise SystemExit(
            f"\nCould not listen on port {REDIRECT_PORT}: {exc}\n"
            "An earlier run is probably still holding it. Free it with:\n"
            f"  lsof -nP -iTCP:{REDIRECT_PORT} -sTCP:LISTEN\n"
            f"  kill <PID>"
        ) from exc

    Thread(target=server.handle_request, daemon=True).start()

    print("\nOpening the Google consent screen...")
    print(f"If it does not open, visit:\n  {url}\n")
    print(f"Waiting up to {AUTH_TIMEOUT_SECONDS}s for the redirect (Ctrl+C to abort)...")
    webbrowser.open(url)

    # Google can refuse before ever redirecting -- an unapproved test user, for
    # instance -- in which case the callback never fires. Time out rather than
    # waiting forever, and sleep between polls instead of spinning a core.
    deadline = time.monotonic() + AUTH_TIMEOUT_SECONDS
    while "code" not in _received and "error" not in _received:
        if time.monotonic() > deadline:
            server.server_close()
            raise SystemExit(
                f"\nTimed out after {AUTH_TIMEOUT_SECONDS}s with no redirect.\n"
                "Google most likely blocked the sign-in before redirecting. Check:\n"
                "  - your account is listed under OAuth consent screen -> Test users\n"
                "  - the app's publishing status is 'Testing'\n"
                "  - the OAuth client is a 'Desktop app'"
            )
        time.sleep(0.2)
    server.server_close()

    if "error" in _received:
        raise SystemExit(f"Authorization failed: {_received['error']}")
    if _received.get("state") != state:
        raise SystemExit("State mismatch — possible CSRF. Aborting.")
    return _received["code"]


def check(label: str, passed: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if passed else 'FAIL'}  {label}{f' -- {detail}' if detail else ''}")
    return passed


async def main() -> int:
    client_id = os.environ.get("BYOC_GDRIVE_CLIENT_ID")
    if not client_id:
        print("Set BYOC_GDRIVE_CLIENT_ID (see this file's docstring for setup).")
        return 2

    run_folder = f"BYOC-validation-{uuid.uuid4().hex[:8]}"
    provider = GoogleDriveProvider(
        client_id=client_id,
        client_secret=os.environ.get("BYOC_GDRIVE_CLIENT_SECRET"),
        redirect_uri=REDIRECT_URI,
        root_folder_name=run_folder,
    )

    verifier = generate_code_verifier(64)
    code = _authorize(provider, verifier, generate_oauth_state(32))
    session = await provider.oauth.exchange_code(
        code=code, code_verifier=verifier, redirect_uri=REDIRECT_URI
    )

    results: list[bool] = []
    print("\nRunning live checks against your Drive...\n")

    results.append(
        check("OAuth returned a refresh token", session.refresh_token is not None,
              "without one the session dies in an hour")
    )

    storage = AsyncBYOC(provider=provider)
    await storage.connect()
    results.append(check("connect() created the app root folder", True, run_folder))

    try:
        obj = await storage.write_text("docs/hello.md", "# Hello from BYOC")
        results.append(
            check("upload returns a virtual path", obj.path == "docs/hello.md", obj.path)
        )

        text = await storage.read_text("docs/hello.md")
        results.append(check("download round-trip", text == "# Hello from BYOC"))

        meta = await storage.metadata("docs/hello.md")
        results.append(check("metadata reports a size", (meta.size or 0) > 0, str(meta.size)))

        for name in AWKWARD_FILENAMES:
            await storage.write_text(name, f"content of {name}")
            back = await storage.read_text(name)
            results.append(check(f"round-trip {name!r}", back == f"content of {name}"))

        listed = await storage.list("notes")
        results.append(
            check("list returns the notes folder contents", len(listed) >= 3,
                  ", ".join(sorted(o.name for o in listed)))
        )

        quota = await storage.get_quota()
        results.append(check("quota reports usage", quota.used > 0, f"{quota.used} bytes used"))

        # Force a genuinely multi-chunk upload. A 6 MiB payload under the 8 MiB
        # default would go up in one chunk, leaving the 308 Resume Incomplete
        # loop and Range-header parsing -- the actually tricky part -- untested.
        chunk_size = 256 * 1024
        big = b"x" * (6 * 1024 * 1024)
        expected_chunks = -(-len(big) // chunk_size)
        seen: list[int] = []
        from byoc.types import UploadOptions

        await storage.upload(
            "large/blob.bin",
            big,
            UploadOptions(
                resumable=True,
                chunk_size=chunk_size,
                on_progress=lambda p: seen.append(p.bytes_uploaded),
            ),
        )
        results.append(
            check(
                f"resumable upload of 6 MiB in {chunk_size // 1024} KiB chunks",
                len(seen) >= expected_chunks - 1,
                f"{len(seen)} progress events, expected ~{expected_chunks}",
            )
        )
        results.append(
            check("progress advances monotonically", seen == sorted(seen), f"last={seen[-1]}")
        )
        results.append(
            check("resumable content round-trip", await storage.read_bytes("large/blob.bin") == big)
        )

        await storage.delete("docs/hello.md")
        results.append(check("delete removes the file", not await storage.exists("docs/hello.md")))

    finally:
        print("\nCleaning up...")
        for name in [*AWKWARD_FILENAMES, "large/blob.bin"]:
            try:
                await storage.delete(name)
            except Exception as exc:
                print(f"  could not delete {name}: {exc}")
        print(f"  NOTE: remove the '{run_folder}' folder from your Drive manually.")
        await storage.disconnect()

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
