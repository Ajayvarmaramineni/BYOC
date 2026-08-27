# BYOC Conformance Fixtures

Language-neutral test vectors shared by every BYOC SDK implementation.

BYOC is not a wire protocol. Two SDKs never talk to each other, they both talk to Google Drive, S3, or WebDAV. So these fixtures cover exactly the surfaces where independent implementations write to **shared external state**, and where drift means a file written by one SDK cannot be read by another.

Everything else (method names, error class hierarchies, sync vs async) is API design, and should be idiomatic per language. It is deliberately **not** specified here.

## The fixtures

| File | Covers | Why it matters |
| :--- | :--- | :--- |
| `path-normalization.json` | `normalizeVirtualPath`, `getBasename`, `getDirname`, `splitPath` | Decides which folder bytes land in |
| `path-encoding.json` | `rfc3986UriEncode`, `encodePathSegments` | Decides the actual S3 key / WebDAV URL |
| `e2ee-envelope.json` | AES-256-GCM envelope byte layout | A one-byte disagreement makes encrypted files permanently unreadable |
| `provider-metadata.json` | `byocVirtualPath` and `x-amz-meta-*` key names | Wire format, not API surface; must stay camelCase in every language |

## Rules

1. **Fixtures are the contract.** If an implementation disagrees with a fixture, fix the implementation, not the fixture.
2. **Changing an expectation is a breaking change.** It means previously written files may no longer be readable. Bump the envelope version (`BYOC_E2EE_V2` → `V3`) rather than redefining an existing one.
3. **Error codes are shared; error *types* are not.** A fixture saying `BYOC_INVALID_INPUT` means TypeScript throws `StorageError` with that `code` and Python raises its equivalent exception. The string is the contract.
4. **Add a case whenever a bug is found.** Every vector in `path-encoding.json` marked `note` exists because that exact input once broke something.

## Running them

**TypeScript**: [`packages/core/tests/spec/conformance.test.ts`](../packages/core/tests/spec/conformance.test.ts):

```bash
npx vitest run packages/core/tests/spec/conformance.test.ts
```

**Python**: planned for `python/tests/test_conformance.py`, loading the same JSON from this directory.

## Regenerating the E2EE vectors

The envelope vectors are generated with fixed salt/IV so they are byte-reproducible. They should only be regenerated when the envelope format itself changes, and that requires a new version header, not an in-place edit.

## What is deliberately not here

- **AWS SigV4 vectors.** AWS publishes its own; both SDKs should test against those rather than a fork of someone else's truth.
- **Capability matrices and method signatures.** API ergonomics, not interop.
- **A prose specification.** These four files plus this README are the spec. A longer document can follow once two implementations disagree about something real.
