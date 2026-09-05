# @byoc/core

Universal storage abstraction for **BYOC (Bring Your Own Cloud)**: one API for storage that end users, organizations, or infrastructure teams already own.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires at least one provider adapter.

## Install

```bash
npm install @byoc/core
# plus an adapter
npm install @byoc/google-drive    # or @byoc/s3-compatible, @byoc/webdav
```

## Usage

```ts
import { BYOC } from "@byoc/core";
import { GoogleDriveProvider } from "@byoc/google-drive";

const storage = new BYOC({
  provider: new GoogleDriveProvider({
    auth: { clientId: process.env.GOOGLE_CLIENT_ID! },
    rootFolderName: "MyApplication"
  })
});

await storage.connect();

await storage.writeText("documents/welcome.md", "# Hello from BYOC!");
const content = await storage.readText("documents/welcome.md");
```

## What's in this package

| Export | Purpose |
| :--- | :--- |
| `BYOC` | The universal client: upload, download, list, delete, move, quota |
| `BYOCProvider` | The interface every adapter implements |
| `MigrationEngine` | Stream-piped transfer between any two registered providers |
| `E2EECrypto`, `EncryptedStorageWrapper` | Client-side AES-256-GCM encryption over any provider |
| `StorageError`, `BYOCErrorCode` | Provider-neutral error taxonomy with `retryable` flags |
| `normalizeVirtualPath`, `encodePathSegments` | Path sanitization and RFC 3986 encoding |
| `SafeLogger` | Logging with automatic token/credential redaction |
| `withRetry` | Exponential backoff for rate-limited providers |

## Multi-provider and migration

```ts
const storage = new BYOC({
  providers: [gdrive, s3, webdav],
  defaultProviderId: "google-drive"
});

storage.useProvider("s3-compatible");

const report = await storage.migrate({
  from: "google-drive",
  to: "webdav",
  paths: ["documents/report.pdf"],
  onProgress: (p) => console.log(`${p.currentFile} (${p.percentage}%)`)
});
```

## Client-side encryption

`EncryptedStorageWrapper` wraps any provider so plaintext never leaves the process.
New objects use the framed `BYOC_E2EE_V3` format, and uploads are encrypted as a
stream with memory bounded by the configured frame size. V1 and V2 objects remain
readable.

```ts
import { EncryptedStorageWrapper } from "@byoc/core";

const secure = new EncryptedStorageWrapper(gdrive, {
  passphrase: process.env.USER_PASSPHRASE!,
  frameSize: 256 * 1024
});

await secure.upload("videos/demo.mp4", videoStream, {
  contentLength: videoSize,
  mimeType: "video/mp4"
});
```

For direct pipelines, `E2EECrypto.encryptStream()` and
`E2EECrypto.decryptStream()` accept iterables of byte chunks. Provider transport
support still varies: TypeScript Local, WebDAV, and S3 consume streams directly;
S3 requires an exact `contentLength`, and Google Drive currently buffers before
its resumable upload loop. `encryptedSize()` returns the exact V3 length when a
custom pipeline needs to set its own transport header.

## Provider independence

`@byoc/core` contains no provider-specific concepts. Drive file IDs, S3 object keys, and WebDAV collections stay private to their adapters. Core speaks only in `path`, `id`, `providerId`, `StorageObject`, and `StorageQuota`.

## License

[Apache-2.0](./LICENSE)
