# Security Policy

BYOC connects applications to storage that other people own, and handles the
credentials that grant that access. Both SDKs are covered by this policy.

## Supported versions

| Version | Supported |
| :--- | :--- |
| 0.2.x | Yes |
| 0.1.x | No |

While the project is below `1.0.0`, only the latest minor release receives
security fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through
[GitHub Private Vulnerability Reporting](https://github.com/Ajayvarmaramineni/BYOC/security/advisories/new),
or by email to **aramineni@wpi.edu**.

A useful report includes the affected SDK and version, the provider adapter if
it is specific to one, a minimal reproduction, and the impact you believe it
has. Expect an acknowledgement within 48 hours.

Please do not include real credentials in a report. A redacted reproduction is
always enough.

## Security architecture

### Minimal OAuth scope

The Google Drive adapter defaults to
`https://www.googleapis.com/auth/drive.file` and nothing else. That scope grants
access only to files the application created, or that the user explicitly opened
with it. It cannot read the rest of a user's Drive.

`drive.appdata` and `drive.file.readonly` are available via `GoogleDriveScope`
but are never requested unless a caller opts in. BYOC never requests the full
`drive` scope, which is what keeps applications out of Google's Restricted Scope
security assessment.

### PKCE and CSRF protection

All OAuth flows use PKCE (RFC 7636) with the `S256` challenge method, derived
from a cryptographically secure random verifier. Conformance is pinned by
`spec/fixtures/pkce.json`, whose first vector is RFC 7636 Appendix B.

A random `state` value is generated for CSRF protection. **Verifying it on the
callback is the caller's responsibility.** BYOC generates the value; it cannot
enforce that the application compares it.

### Client-side encryption

`EncryptedStorageWrapper` encrypts payloads before they reach any provider, so
the storage operator never sees plaintext.

- AES-256-GCM, with a key derived by PBKDF2-HMAC-SHA256
- 600,000 iterations by default, recorded in the envelope so raising the work
  factor does not orphan previously encrypted files
- The iteration count is read from untrusted storage and consumed before the GCM
  tag can authenticate it, so it is range-checked to 10,000..2,000,000 before
  any key derivation runs
- The magic header, iteration count, and salt are bound as GCM additional
  authenticated data, so the envelope header cannot be edited undetected
- Envelope layout is pinned by `spec/fixtures/e2ee-envelope.json` and is
  byte-identical across both SDKs

Payloads are buffered in memory, so E2EE does not currently compose with
resumable streaming uploads. The wrapper reports `resumableUploads: false`
rather than failing at upload time.

### Credential storage

The default token storage is in memory and is lost on restart.

For long-running services, `EncryptedFileTokenStorage` persists sessions
encrypted with the same AES-256-GCM envelope, in a file created with `0600`
permissions before any bytes are written. A refresh token is a long-lived
credential for the user's storage account: never write one in plaintext, and
never commit one.

`revoke()` clears local storage even when the remote revocation call fails, so a
revoked token cannot linger on disk.

### Credential redaction in logs

All logging passes through a redacting logger:

- TypeScript: `SafeLogger` in `packages/core/src/utils/logger.ts`
- Python: `SafeLogger` in `python/src/byoc/logging.py`

Bearer tokens, Google `ya29.` tokens, refresh tokens, client secrets, API keys,
and passwords are scrubbed by both value pattern and key name, recursively
through nested structures and exception traces, before anything reaches a
handler.

The default logger is silent, so importing BYOC never emits credentials by
accident.

### Path handling

Every virtual path is normalized before reaching a provider:

- TypeScript: `normalizeVirtualPath` in `packages/core/src/paths/resolver.ts`
- Python: `normalize_virtual_path` in `python/src/byoc/paths.py`

Directory traversal (`..`) is rejected with an error rather than silently
stripped. Control characters, including NUL, are removed. Path segments are
percent-encoded per RFC 3986 before they are used in a URL, so characters such
as `#` and `?` in a filename cannot truncate an object key.

### Query injection

The Google Drive adapter escapes `\` and `'` in every value interpolated into a
Drive API query, in that order. Without it, a filename containing an apostrophe
produces a malformed query, and a crafted path could inject additional query
clauses.

### Transport and retries

All provider traffic is HTTPS. Retries use exponential backoff with full jitter
and apply only to errors a provider marked retryable, so a permission failure is
never retried.

## Guidelines for contributors

1. Never commit real OAuth secrets, access tokens, or refresh tokens.
2. Never use real user data or credentials in test fixtures. The values in this
   repository, such as `AKIAIOSFODNN7EXAMPLE` and `minioadmin`, are published
   vendor examples and local test-server defaults.
3. Keep secrets in `.env`, which is git-ignored.
4. Any new value interpolated into a provider query or URL must be escaped or
   encoded for that provider's syntax.
5. Changing a conformance fixture can make previously written files unreadable.
   Bump the format version instead of editing a vector in place.
6. Run the full suite in every affected SDK before submitting:
   `npm test` and `pytest`, plus `mypy src` and `ruff check .` for Python.
