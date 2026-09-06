# Changelog

All notable changes to BYOC are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). While the
version is below `1.0.0`, the public API may change between minor releases.

---

## [0.4.0] - 2026-09-06

The release where a file no longer has to fit in memory, and where the bytes no
longer have to pass through your server at all.

### Highlights

**Every adapter streams, in both SDKs.** S3, WebDAV, Google Drive, local and
in-memory all accept an async iterator and transfer it without buffering the
object. An 800 MB upload holds a flat ~57 MB of resident memory instead of
850 MB, and a file larger than RAM is now possible rather than impossible.
Migration pipes source to target directly, so moving objects between providers
is bounded by the chunk size rather than by the largest file.

**Direct browser upload.** `createUploadGrant()` mints a capability that is safe
to hand to an untrusted client, and [`@byoc/browser`](https://www.npmjs.com/package/@byoc/browser)
consumes it. The bytes go from the user's machine to the user's own cloud; your
server sees a path and a size and never any content. S3 signs a PUT covering
only `host` and `UNSIGNED-PAYLOAD`; Google Drive opens a resumable session whose
URI is itself the capability and needs no `Authorization` header, keeping your
OAuth token server-side.

**Framed `BYOC_E2EE_V3` encryption.** AES-GCM authenticates one message with one
tag, so encrypting a file used to mean holding all of it. V3 splits the payload
into independently authenticated frames, binding the header, frame index and a
final-frame marker as additional authenticated data so reordering, truncation
and header swaps are all detected. V1 and V2 envelopes remain readable.

### Added

- `@byoc/browser`: `uploadWithGrant()` with progress, retry, abort and resumable chunking
- `createUploadGrant()` on both clients, gated on a new `directUpload` capability
- `encryptStream` / `decryptStream` in both SDKs
- Streaming upload for S3 (multipart), WebDAV (chunked) and Google Drive (resumable)
- `spec/fixtures/upload-grant.json`, pinning the grant wire format across SDKs
- Exact V3 envelope sizing via `encryptedSize()` / `encrypted_size()`
- `UploadOptions.contentLength` for exact-length streaming requests; the
  encrypted wrapper converts plaintext length to the V3 envelope length
- A deterministic V3 cross-SDK fixture plus hostile chunk-boundary, truncation,
  reorder, oversized-frame, empty-object and header-tampering tests
- A repeatable bounded-memory benchmark via `npm run benchmark:streaming`
- Static security scanning in CI: `bandit` and `pip-audit`

### Fixed

- **S3 rejected unknown-length streams.** A chunked `PUT` gets `411 Length Required`, so such a body now goes up as a multipart upload. Each part is fully known when signed, so every part signs its real SHA-256 rather than `UNSIGNED-PAYLOAD` -- streaming no longer weakens request signing on that path.
- **Provider-returned XML could expand DTD entities.** `ListObjectsV2` and `PROPFIND` responses are attacker-influenceable and parsed on every list call; both parsers now refuse entity expansion, with tests asserting the refusal rather than trusting a library default.
- **A `null` optional field in a grant broke every upload from a Python backend to a JavaScript frontend**, because `size > null` is true in JavaScript. Absent optional fields are now omitted rather than serialized as null.
- **A missing grant expiry was treated as "never expires."** It now fails closed.
- **The Python client dropped a provider defining `__len__` while it was empty**, having registered by truthiness rather than `is not None`.
- **A token-storage test asserted a two-byte needle was absent from random ciphertext**, which collides by chance and failed roughly one push in a hundred while looking like a Python-version bug.

### Changed

- `EncryptedStorageWrapper` streams true stream inputs, keeps buffered inputs
  payload-signed and retryable, reports plaintext sizes, and preserves the
  underlying provider's resumable capability
- Pure cryptography interop tests no longer require a running S3 server
- All packages and adapter manifests report `0.4.0`
- `SECURITY.md` records where streaming has landed per adapter and the measured memory figures

### Verification

Google Drive is validated against a real account by
`python/scripts/validate_gdrive_live.py`, now including the streaming path:
20/20 checks passing, among them a stream of exactly one chunk, which is the
case the resumable lookahead exists for. Both SDKs stream the same 100 MB file
to identical SHA-256.

```
TypeScript   416 tests
Python       435 tests, plus 42 integration and 13 interop
```

### Known limitations

- **`@byoc/connect` and the metadata index are not in this release.** Both need design decisions -- token storage location, and what happens when a user edits a file directly in their cloud -- that are better made deliberately than quickly.
- **Two instances of the same provider type still cannot be registered on one client**, since the registry is keyed by manifest id.
- **`move` and `copy` of a filename containing `?` fail against wsgidav.** BYOC sends a correctly encoded `Destination`; wsgidav decodes it and re-parses as a URL, truncating at the `?`. Confirmed with `curl` against the server directly.

---

## [0.3.0] - 2026-08-27

The release that makes BYOC runnable without an account, and closes a set of
operations that existed in one SDK but not the other.

### Highlights

**Two providers that need no credentials.** `@byoc/local` and `@byoc/memory` on npm, `LocalFileSystemProvider` and `MemoryProvider` in the Python package. Both pass the same behavioural suite as the network-backed adapters and both certify clean against the provider compliance harness. Evaluating BYOC, developing offline, and unit-testing code that talks to storage no longer require signing up for anything.

**`copy()` is reachable.** It was implemented on all three TypeScript adapters in 0.2.x and exposed by neither client, so no caller could reach any of it. Both clients now expose it, and the Python S3 and Google Drive adapters have real implementations rather than a capability flag with nothing behind it.

**A conformance fixture for the operation surface.** The existing fixtures pin bytes, and an adapter missing a method still writes identical bytes for everything it does implement. `spec/fixtures/provider-operations.json` pins which operations and capabilities each adapter has, in both SDKs, so this class of divergence fails CI instead of shipping.

### Added

- `@byoc/local` / `LocalFileSystemProvider`: files on a local disk or mounted volume, with paths confined to the configured root
- `@byoc/memory` / `MemoryProvider`: an in-memory test double with `snapshot()`, `clear()`, and a configurable stream chunk size
- `copy()` on both clients, capability-gated like `move()`
- `walk()` on both clients: every object beneath a path, descending into folders
- `delete_tree()`: recursive delete, children before parents, failures collected rather than aborting
- `delete_many()`: concurrent batch delete returning per-path outcomes, because a partial delete is the common real case
- `signed_url()` / `getSignedUrl()` on both clients, gated on `public_urls`. It existed only on the S3 adapter before
- `copy()` and `move()` on the Python S3 adapter, using `x-amz-copy-source`
- `copy()` and `move()` on the Python Google Drive adapter, using `files.copy` and a parent-list `PATCH`
- `spec/fixtures/provider-operations.json`, and the conformance suites that read it in both SDKs
- Both new adapters accept an async iterator as upload input, making good on what `StorageInput` has always declared

### Fixed

- **S3 server-side copy truncated the copy source at a `#` or `?`.** `copyObject` built the `x-amz-copy-source` header with `encodeURI`, which leaves both characters intact, so copying `draft#2.pdf` asked S3 for `draft` and reported the object missing. The header is now RFC 3986 encoded per segment, the same rule the object URL already followed. Verified against MinIO in both SDKs.
- **The Python client dropped a provider that defined `__len__` while it was empty.** Registration tested the adapter for truthiness rather than `is not None`, so an empty `MemoryProvider` failed to register and the client reported that no provider had been supplied.
- **`S3CompatibleProvider` and `GoogleDriveProvider` in Python declared `server_side_copy=True` with no `copy` method.** Callers who feature-detected on the capability got an `AttributeError` instead of a clean `CapabilityUnsupportedError`.
- **The in-memory provider did not report nested keys as folders**, unlike S3, which returns them as `CommonPrefixes`. Anything below the first level was invisible to a tree walk, so `delete_tree()` reported complete success while leaving those objects in place. Caught before release by running the two providers through one shared suite.

### Changed

- Adapter manifests report `adapterVersion` / `adapter_version` `0.3.0`
- The Python S3 adapter's `presigned_url()` is now `signed_url()`, matching what the client calls. The old name still works as an alias.
- `AuthType` gained no new members: the `"local"` variant already existed and is now used

### Known limitations

- **E2EE still buffers the whole payload**, so client-side encryption and multi-gigabyte resumable uploads remain mutually exclusive. The design for a framed envelope is in [`docs/design/streaming-and-chunked-e2ee.md`](./docs/design/streaming-and-chunked-e2ee.md); the transport work is not in this release.
- **Streaming uploads are still buffered by the three network adapters.** Only the local and in-memory providers consume an async iterator without collecting it first.
- **`move` and `copy` of a filename containing `?` fail against wsgidav.** BYOC sends a correctly percent-encoded `Destination` header; wsgidav decodes it and then re-parses the result as a URL, truncating at the `?`. Confirmed with `curl` against the server directly, and reproducible in both SDKs. Other WebDAV servers may or may not share the defect.
- **The Python SDK is async only.** A synchronous facade for Celery, Django, and scripts is planned.
- **Two instances of the same provider type cannot be registered on one client**, since the registry is keyed by manifest id.
- **Google Drive is not covered by CI**, as it needs a real account and a browser consent step.

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

[0.4.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.4.0
[0.3.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.3.0
[0.2.1]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.2.1
[0.2.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.2.0
[0.1.0]: https://github.com/Ajayvarmaramineni/BYOC/releases/tag/v0.1.0
