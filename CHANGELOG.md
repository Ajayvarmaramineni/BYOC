# Changelog

All notable changes to BYOC are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). While the
version is below `1.0.0`, the public API may change between minor releases.

---

## [0.2.1] - 2026-08-26

A packaging fix for the TypeScript SDK. No runtime behaviour changed, and the
Python SDK is unaffected, so `byoc-storage` stays at 0.2.0.

### Fixed

- **`@byoc/core` and `@byoc/google-drive` did not declare `@types/node`**, even
  though their published `.d.ts` files reference `Buffer` and `node:stream` in
  the public API. Consumers compiling with `skipLibCheck: false` saw
  `Cannot find name 'Buffer'` reported from inside the package. Both now depend
  on `@types/node`, so it resolves automatically.

### Changed

- All packages declare `homepage`, `bugs`, `engines` (Node >= 20), and `author`,
  so the npm pages link back to the repository and issue tracker
- Packages are marked `sideEffects: false`, letting bundlers tree-shake unused
  adapters

---

## [0.2.0] - 2026-08-26

The release that makes BYOC a two-language project, and the first one where every adapter has been run against a real server rather than a mock.

### Highlights

**Python SDK.** `byoc-storage` on PyPI (imported as `byoc`), with full adapter parity: Google Drive, S3-compatible, and WebDAV. It is idiomatic Python rather than a transliteration of the TypeScript: `snake_case`, real exception types you catch by class, `asyncio` throughout, dataclasses instead of a forced Pydantic dependency, and `mypy --strict` clean.

**Cross-SDK interop, proven automatically.** Both SDKs run against the same conformance vectors in [`spec/fixtures`](./spec), and an interop suite drives both against the same live servers on every push. A file written by a Next.js frontend is readable by a FastAPI backend, including client-side encrypted files: the AES-256-GCM envelope is byte-identical across both languages, at any valid iteration count.

**Live integration testing.** CI now runs against a real MinIO server and a real RFC 4918 WebDAV server, and fails the build if either suite silently self-skips. Google Drive cannot run in CI, so it ships with a manual validation script that exercises the full OAuth flow, awkward filenames, multi-chunk resumable upload, quota, and delete.

**Every provider is live-verified.** All four move off Beta.

### Added

- `byoc-storage` Python SDK: client, path handling, E2EE, retry, and all three provider adapters
- `spec/fixtures`: language-neutral conformance vectors for path normalization, RFC 3986 encoding, the E2EE envelope, provider metadata, AWS SigV4, and PKCE
- Cross-SDK interop suite covering storage round-trips, listings, encryption, and path handling in both directions
- Live integration suites for S3 (MinIO) and WebDAV, which skip cleanly when no server is reachable
- `python/scripts/validate_gdrive_live.py` for manual Google Drive validation
- [Google Drive OAuth Setup guide](./docs/google-oauth-setup.md), covering the Cloud console's silent-failure spots
- `AsyncBYOC` client with multi-provider registry, runtime switching, capability gating, and migration
- `EncryptedFileTokenStorage` for persisting OAuth sessions encrypted at rest, with owner-only file permissions
- Presigned URL support in the S3 adapter
- `partial` migration status, distinguishing "copied, but source cleanup failed" from a real transfer failure

### Fixed

- **Object keys containing `#` or `?` were silently truncated**, so `draft#2.pdf` and `draft#3.pdf` both wrote to the key `draft`, and the second upload overwrote the first. Path segments are now RFC 3986 encoded in both the S3 and WebDAV adapters.
- **AWS SigV4 signatures were rejected when a caller passed a canonically-cased header.** `Content-Type` was signed with an empty value while the real value went on the wire. Header names are now normalized before both signing and sending.
- **SigV4 canonical query strings were unsorted and used `+` for spaces**, so any request with two or more query parameters failed. This also blocked paginated listing.
- **Google Drive queries did not escape `'` or `\`**, so any filename containing an apostrophe returned a 400, and a crafted path could inject query clauses.
- **`list()` returned an empty array** in the S3 and WebDAV adapters rather than listing anything.
- **S3 `list()` stopped at 1000 objects**, silently dropping everything past the first page. It now follows `NextContinuationToken`.
- **Migration double-counted a file** when source deletion failed, reporting it as both migrated and failed.
- **Control characters were not stripped from virtual paths**, contradicting the documented behavior in `SECURITY.md`.
- **Google Drive cache self-healing missed the common case.** A cached file ID that resolved but pointed at a deleted file surfaced as a raw 404; the retry now wraps the operation, not just the resolution.
- Published packages shipped `dist/tsconfig.tsbuildinfo` (33 kB of build cache containing local absolute paths) and carried no README or LICENSE.
- Packages declared `"module": "./dist/index.mjs"`, a file that was never emitted, breaking bundler resolution.

### Security

- **PBKDF2 iterations raised from 100,000 to 600,000**, and key derivation moved off the event loop.
- **The E2EE envelope now records its own iteration count**, so raising the work factor no longer orphans previously encrypted files. Bumped to `BYOC_E2EE_V2`; V1 envelopes remain readable.
- **The iteration count is range-checked before key derivation.** It is read from untrusted storage and consumed before the GCM tag can authenticate it, so a 4-byte edit could otherwise force minutes of PBKDF2 per file. Accepted range is 10,000 to 2,000,000.
- **The magic header, iteration count, and salt are bound as GCM additional authenticated data**, so the envelope header cannot be edited undetected.
- Refresh tokens are persisted encrypted, in files created with `0600` before any bytes are written.
- `revoke()` clears local token storage even if the remote call fails.
- All development dependencies updated; `npm audit` reports zero vulnerabilities.

### Changed

- Google Drive, S3-compatible, WebDAV, and the Provider SDK are no longer marked Beta
- WebDAV `metadata()` in Python uses `PROPFIND` at `Depth: 0` rather than `HEAD`, which returns richer data uniformly and avoids a keep-alive desync some servers trigger by attaching a body to a `HEAD` 404
- `S3CompatibleProvider` no longer leaks `root_prefix` into a returned `StorageObject.path`, so returned paths can be fed straight back into the client
- CI runs a Node 20/22 matrix, a Python 3.10 through 3.13 matrix, and a live integration job
- All package manifests declare `Apache-2.0`, a repository URL, and `publishConfig.access: public`

### Known limitations

- **E2EE buffers the whole payload**, so client-side encryption and multi-gigabyte resumable uploads are currently mutually exclusive. The wrapper reports `resumableUploads: false` rather than failing at upload time.
- **The Python SDK is async only.** A synchronous facade for Celery, Django, and scripts is planned.
- **Two instances of the same provider type cannot be registered on one client**, since the registry is keyed by manifest id. This blocks migrating between two buckets on the same provider.
- **Google Drive is not covered by CI**, as it needs a real account and a browser consent step. Validate it with `python/scripts/validate_gdrive_live.py`.

---

## [0.1.0] - 2026-08-25

Initial release: the TypeScript storage abstraction, with Google Drive, S3-compatible, and WebDAV adapters, a stream-piped migration engine, client-side E2EE, and a provider certification SDK.

---

[0.2.1]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.2.1
[0.2.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.2.0
[0.1.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.1.0
