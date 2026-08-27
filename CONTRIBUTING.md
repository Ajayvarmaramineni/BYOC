# Contributing to BYOC

Thanks for considering a contribution. BYOC is a monorepo containing two peer
SDKs that implement the same contract, so most changes touch both.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Repository layout

```text
packages/          TypeScript SDK, published to npm as @byoc/*
python/            Python SDK, published to PyPI as byoc-storage
spec/fixtures/     conformance vectors shared by both SDKs
docs/              setup and integration guides
examples/          runnable demonstrations
```

## Development setup

Both SDKs are developed independently. Node 20 or newer, Python 3.10 or newer.

### TypeScript

```bash
npm install
npm run build
npm test
npm run typecheck
```

### Python

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

pytest
mypy src
ruff check .
```

Without activating the virtualenv, call the binaries directly: `.venv/bin/pytest`,
`.venv/bin/mypy src`, `.venv/bin/ruff check .`

## Running the full suite

```
TypeScript   193 tests   npm test && npm run typecheck
Python       224 tests   pytest && mypy src && ruff check .
```

Integration and interop tests skip automatically when no server is reachable, so
the default run stays offline. To exercise them locally, start a real S3 server:

```bash
brew install minio && minio server /tmp/byoc-minio-data --address :9000
```

The WebDAV suite starts its own in-process RFC 4918 server and needs no setup.
CI runs both against real servers on every push.

Google Drive cannot run in CI, since it needs a real account and a browser
consent step. If a change touches the Drive adapter, OAuth, or the path
resolver, validate it manually:

```bash
cd python && .venv/bin/python scripts/validate_gdrive_live.py
```

See the [Google Drive OAuth setup guide](./docs/google-oauth-setup.md) for the
one-time console configuration.

---

## The two rules that matter most

### 1. Core stays provider-neutral

> Google Drive is BYOC's first reference provider. Google Drive is not BYOC's
> architecture.

Provider-specific concepts, APIs, authentication mechanisms, proprietary
identifiers, and error quirks belong strictly inside adapters.

| Forbidden in core | Required in core |
| :--- | :--- |
| `driveFileId`, `s3ObjectKey`, `blobName` | `id`, `providerId` |
| `driveFolderId`, `s3Bucket`, `blobContainer` | `path`, `container` |
| `googleDriveAccessToken`, `awsAccessKey` | `Credential`, `AuthSession` |

### 2. The SDKs must not drift

Both SDKs run against the same vectors in [`spec/fixtures`](./spec). Those
fixtures cover the surfaces where independent implementations write to shared
external state:

| Fixture | Covers |
| :--- | :--- |
| `path-normalization.json` | which folder bytes land in |
| `path-encoding.json` | the actual object key or URL |
| `e2ee-envelope.json` | the encrypted envelope byte layout |
| `provider-metadata.json` | metadata key names written into provider storage |
| `sigv4.json` | AWS request signing |
| `pkce.json` | the OAuth challenge derivation |

**Changing an expectation in a fixture is a breaking change.** It can make
previously written files unreadable. Bump the format version, as
`BYOC_E2EE_V2` did, rather than editing a vector in place.

Everything else, including method names, error class hierarchies, and sync
versus async, is idiomatic per language and deliberately not specified. Python
uses `snake_case` and raises exceptions; TypeScript uses `camelCase` and throws.
Only the error *code* strings are shared.

---

## Adding a provider adapter

1. Create the package under `packages/` or a module under
   `python/src/byoc/providers/`.
2. Implement `BYOCProvider`.
3. Declare capabilities honestly. If a provider has no real folders, report
   `folders: false` and let `create_folder` raise `CapabilityUnsupportedError`.
   Do not fake a capability with prefix tricks.
4. Keep every provider-specific concept inside the adapter.
5. Verify with the certification suite:

```ts
import { runProviderComplianceSuite } from "@byoc/provider-sdk";
const report = await runProviderComplianceSuite(() => new MyProvider(config));
```

6. Add integration tests against a real server if one can run locally or in CI.

## Testing expectations

New behaviour needs a test that fails without the change.

Mocks prove what a request looks like; only a real server proves it is accepted.
Every serious bug in this project was invisible to mocked tests: object keys
containing `#` or `?` were silently truncated, SigV4 signatures were rejected
when a caller passed a canonically-cased header, and Drive queries broke on any
filename containing an apostrophe.

When fixing a bug of that kind, add the offending input to the shared fixtures
so neither SDK can regress.

## Pull requests

1. Branch from `main`.
2. Keep the change focused. Unrelated refactors make review harder.
3. Run the full suite in every affected SDK.
4. Update the relevant README if the public API changed.
5. Fill in the pull request template, including the cross-SDK section when the
   change touches a conformance surface.

Commit messages: a short imperative summary under 72 characters, with detail in
the body if the change needs explaining.

## Security

Do not open a public issue for a vulnerability. See the
[security policy](./SECURITY.md) for private reporting.

Never commit real credentials, and never use real user data in test fixtures.

## License

Contributions are licensed under the [Apache License 2.0](./LICENSE).
