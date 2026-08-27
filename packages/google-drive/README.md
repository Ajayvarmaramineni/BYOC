# @byoc/google-drive

Google Drive provider adapter for **BYOC (Bring Your Own Cloud)**: keep application files in the Drive account the end user already owns.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.2.0.** Unit tested, and validated against the live Google Drive API.

## Install

```bash
npm install @byoc/core @byoc/google-drive
```

## Setup

You need a Google Cloud OAuth client before any of this works. [**Google Drive OAuth Setup**](../../docs/google-oauth-setup.md) covers it end to end, including the console's silent-failure spots.

## OAuth 2.0 with PKCE

This adapter uses the non-restricted `drive.file` scope, so an application never needs a Google Restricted Scope Security Assessment. It can only see files it created or that the user explicitly opened with it.

```ts
import { BYOC } from "@byoc/core";
import {
  GoogleDriveProvider,
  GoogleDriveScope,
  generateCodeVerifier,
  generateCodeChallenge,
  generateOAuthState
} from "@byoc/google-drive";

const codeVerifier = generateCodeVerifier(64);
const codeChallenge = await generateCodeChallenge(codeVerifier);
const state = generateOAuthState(32);

const gdrive = new GoogleDriveProvider({
  auth: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    redirectUri: "https://myapp.com/api/auth/callback",
    scopes: [GoogleDriveScope.FILE]
  },
  rootFolderName: "MyApplication"
});

// Redirect the user here, then handle the callback:
const loginUrl = gdrive.oauth.getAuthorizationUrl({ state, codeChallenge });
await gdrive.oauth.exchangeCode({ code, codeVerifier });

const storage = new BYOC({ provider: gdrive });
await storage.connect();
await storage.writeText("notes/meeting.md", "# Q3 Strategy Notes");
```

## Persisting refresh tokens

The default `InMemoryTokenStorage` clears on restart. For long-lived sessions use `EncryptedFileTokenStorage`, which persists tokens with AES-256-GCM:

```ts
import { EncryptedFileTokenStorage } from "@byoc/google-drive";

const gdrive = new GoogleDriveProvider({
  auth: { clientId: process.env.GOOGLE_CLIENT_ID! },
  tokenStorage: new EncryptedFileTokenStorage({
    filePath: "./.byoc-session.enc",
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY!
  })
});
```

## What this adapter handles

- **Virtual POSIX paths**: `users/123/report.pdf` is resolved to Drive's opaque file IDs, with nested folders created on demand.
- **404 self-healing**: if a user renames or deletes a file in the Drive web UI, the stale cache entry is invalidated and the path re-resolved.
- **Resumable uploads**: multi-gigabyte files in 256 KiB-aligned chunks with `onProgress` callbacks and network-failure resumption.
- **Query escaping**: filenames containing `'` or `\` are escaped per the Drive API v3 spec.
- **Rate limiting**: 429 and 5xx responses retried with exponential backoff.

## License

[Apache-2.0](./LICENSE)
