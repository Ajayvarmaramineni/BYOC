# byoc-storage

[![PyPI](https://img.shields.io/pypi/v/byoc-storage?style=flat-square&color=3776AB&logo=pypi&logoColor=white)](https://pypi.org/project/byoc-storage/)
[![Python](https://img.shields.io/pypi/pyversions/byoc-storage?style=flat-square&color=3776AB)](https://pypi.org/project/byoc-storage/)
[![Tests](https://img.shields.io/badge/Tests-224%20Passed-brightgreen?style=flat-square)](https://github.com/Ajayvarmaramineni/BYOC)
[![Types](https://img.shields.io/badge/mypy-strict-blue?style=flat-square)](https://github.com/Ajayvarmaramineni/BYOC)
[![License](https://img.shields.io/badge/License-Apache%202.0-orange?style=flat-square)](https://github.com/Ajayvarmaramineni/BYOC/blob/main/LICENSE)

Python SDK for **BYOC (Bring Your Own Cloud)**: one storage API for Google Drive, Nextcloud, and S3-compatible clouds, so files live in accounts the end user already owns.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Peer implementation of [`@byoc/core`](https://www.npmjs.com/package/@byoc/core) on npm, verified interoperable by an automated cross-SDK suite.

## Why

Rather than paying to host every file in one central bucket, BYOC lets an application read and write storage the end user already owns: a personal Google Drive, a company Nextcloud, an organization's own R2 bucket.

```text
FastAPI / Django / Celery
   │
   ├── PostgreSQL  → users, jobs, metadata pointers
   │
   └── byoc        → the actual PDFs, images, audio, model artifacts
           │
           └── the user's own cloud
```

Use Postgres for application data. Use BYOC for the user's files.

## Install

```bash
pip install byoc-storage
```

The distribution is named `byoc-storage` because `byoc` on PyPI belongs to an
unrelated CLI framework. The import name is still `byoc`:

```python
import byoc
```

> If you also depend on the unrelated `byoc` CLI framework, do not install both
> into the same environment: they share the `byoc` import name and will shadow
> each other.

## Usage

```python
import os
from byoc import AsyncBYOC
from byoc.providers.s3 import S3CompatibleProvider

storage = AsyncBYOC(
    provider=S3CompatibleProvider(
        endpoint="https://<account_id>.r2.cloudflarestorage.com",
        bucket="user-assets",
        region="auto",
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )
)

async with storage:
    await storage.write_text("documents/welcome.md", "# Hello from BYOC!")
    content = await storage.read_text("documents/welcome.md")
```

### Multiple providers and migration

```python
storage = AsyncBYOC(providers=[drive, r2, nextcloud], default_provider_id="s3-compatible")

storage.use_provider("webdav")
await storage.write_bytes("images/banner.png", data)

report = await storage.migrate(
    source="s3-compatible",
    target="webdav",
    paths=["documents/report.pdf"],
    on_progress=lambda p: print(f"{p.current_file} ({p.percentage}%)"),
)
```

`report.files_partial` counts files that reached the target but whose source
cleanup failed. The transfer is done, so retrying those would re-upload for
nothing.

> **Async only for now.** A synchronous facade for Celery, Django, and scripts
> is planned but not yet implemented; use `asyncio.run()` in the meantime.

## Google Drive

Drive needs a Google Cloud OAuth client. See [**Google Drive OAuth Setup**](https://github.com/Ajayvarmaramineni/BYOC/blob/main/docs/google-oauth-setup.md), then verify your setup with:

```bash
.venv/bin/python scripts/validate_gdrive_live.py
```

## Cross-SDK compatibility

This SDK and the TypeScript SDK are peer implementations of the same contract. Both run against the shared conformance vectors in [`spec/fixtures`](https://github.com/Ajayvarmaramineni/BYOC/blob/main/spec), so a file written by a Next.js frontend can be read by a FastAPI backend, including client-side encrypted files, whose envelope format is byte-identical across both.

## Development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

pytest              # unit + conformance suite
mypy src            # strict type checking
ruff check .        # lint
```

Without activating, call the venv binaries directly: `.venv/bin/pytest`,
`.venv/bin/mypy src`, `.venv/bin/ruff check .`

## License

[Apache-2.0](https://github.com/Ajayvarmaramineni/BYOC/blob/main/LICENSE)
