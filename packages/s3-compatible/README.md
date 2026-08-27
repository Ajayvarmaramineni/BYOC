# @byoc/s3-compatible

S3-compatible provider adapter for **BYOC (Bring Your Own Cloud)**: Cloudflare R2, AWS S3, MinIO, Wasabi, and any other S3 API-compatible endpoint.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.2.0.** Unit tested, and validated against a live MinIO server in CI.

## Install

```bash
npm install @byoc/core @byoc/s3-compatible
```

## Usage

```ts
import { BYOC } from "@byoc/core";
import { S3CompatibleProvider } from "@byoc/s3-compatible";

const storage = new BYOC({
  provider: new S3CompatibleProvider({
    endpoint: "https://<account_id>.r2.cloudflarestorage.com",
    bucket: "user-assets",
    region: "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    rootPrefix: "production/data"
  })
});

await storage.connect();
await storage.writeBuffer("images/banner.png", imageBuffer);
```

For MinIO and other path-style endpoints, set `forcePathStyle: true`.

## Presigned URLs

Hand a browser a time-limited URL without proxying bytes through your server:

```ts
import { createPresignedS3Url } from "@byoc/s3-compatible";

const url = createPresignedS3Url(config, objectUrl, {
  method: "GET",
  expiresInSeconds: 3600
});
```

## What this adapter handles

- **AWS Signature Version 4**: canonical request construction verified against AWS reference vectors, with RFC 3986 query canonicalization and case-insensitive header normalization.
- **Object key encoding**: keys containing `#`, `?`, spaces, or unicode are percent-encoded per segment, so they round-trip intact.
- **Paginated listing**: `list()` follows `IsTruncated` / `NextContinuationToken` past the 1000-key response cap.
- **Server-side copy**: `x-amz-copy-source` for same-bucket moves without transferring bytes.

## Capabilities

S3 has no native folder or quota concept, so `folders` and `quota` are reported `false`. `createFolder()` and `getQuota()` throw `CAPABILITY_UNSUPPORTED` rather than silently no-op'ing.

## License

[Apache-2.0](./LICENSE)
