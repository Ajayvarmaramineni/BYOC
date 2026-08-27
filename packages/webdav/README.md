# @byoc/webdav

WebDAV provider adapter for **BYOC (Bring Your Own Cloud)**: Nextcloud, ownCloud, Synology NAS, and any RFC 4918 WebDAV server.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.2.0.** Unit tested, and validated against a live RFC 4918 server in CI.

## Install

```bash
npm install @byoc/core @byoc/webdav
```

## Usage

```ts
import { BYOC } from "@byoc/core";
import { WebDAVProvider } from "@byoc/webdav";

const storage = new BYOC({
  provider: new WebDAVProvider({
    endpoint: "https://nextcloud.company.com/remote.php/dav/files/alex/",
    username: "alex",
    password: process.env.NEXTCLOUD_APP_PASSWORD!,
    rootFolder: "MyApplication"
  })
});

await storage.connect();
await storage.writeText("notes/todo.md", "# This week");
```

Bearer-token servers can pass `token` instead of `username`/`password`.

> Use an **app password**, not the account password. Nextcloud and Synology both issue scoped app passwords that can be revoked independently.

## What this adapter handles

- **PROPFIND listing**: multistatus XML parsed into `StorageObject[]`, with `Depth: 1` for single-level directory listings.
- **Folder hierarchy**: `MKCOL` issued for each missing ancestor before an upload.
- **Path encoding**: segments percent-encoded per RFC 3986, so `#`, `?`, spaces, and unicode filenames survive.
- **Quota**: reported via `quota-available-bytes` where the server supports it.

## Capabilities

WebDAV has no resumable-upload protocol, so `resumableUploads` is `false`. Large files are sent as a single `PUT`.

## License

[Apache-2.0](./LICENSE)
