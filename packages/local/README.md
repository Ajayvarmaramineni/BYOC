# @byoc/local

Local filesystem provider adapter for **BYOC (Bring Your Own Cloud)**.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.3.0.** Unit tested and certified against the provider compliance suite.

The provider that needs no account, no network, and no credentials. Use it to
evaluate BYOC before signing up for anything, to develop offline, and to back a
self-hosted deployment with a mounted volume as first-class storage rather than
a special case.

## Install

```bash
npm install @byoc/core @byoc/local
```

## Usage

```ts
import { BYOC } from "@byoc/core";
import { LocalFileSystemProvider } from "@byoc/local";

const storage = new BYOC({
  provider: new LocalFileSystemProvider({ rootDirectory: "./storage" })
});

await storage.connect();

await storage.writeText("reports/q3.md", "# Q3");
console.log(await storage.readText("reports/q3.md"));
console.log(await storage.list("reports"));
```

Swap in `S3CompatibleProvider`, `WebDAVProvider`, or `GoogleDriveProvider`
later and none of the calling code changes.

## Configuration

| Option | Type | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `rootDirectory` | `string` | required | Directory that backs this provider |
| `createRoot` | `boolean` | `true` | Set `false` to require the directory to already exist |

## Capabilities

| Capability | Supported | Notes |
| :--- | :--- | :--- |
| `folders` | yes | Real directories |
| `serverSideCopy` | yes | `fs.cp` / `fs.rename`, no bytes through your process |
| `quota` | yes | Reports the backing filesystem, not the directory |
| `publicUrls` | no | A local path is not reachable by a browser |
| `sharing` | no | |
| `resumableUploads` | no | |
| `versioning` | no | |

## Path safety

Every path is confined to `rootDirectory`. `..` segments are rejected before
they reach the adapter, and the resolved target is rechecked against the
resolved root afterwards, so a **symlink pointing outside the root cannot be
read or written through** — a case traversal filtering alone does not catch.

## Custom metadata

The filesystem cannot store a MIME type or arbitrary key-value metadata on a
file. When you supply either, the adapter writes a sidecar under a single
`.byoc/` directory at the root. That directory is hidden from `list()`, so it
never appears as content.

If you never pass metadata, no sidecar is written and the directory holds
nothing but your own files.

## License

Apache-2.0
