# @byoc/memory

In-memory provider adapter for **BYOC (Bring Your Own Cloud)**.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.3.0.** Unit tested and certified against the provider compliance suite.

A test double that behaves like a real provider. Use it to unit-test code that
talks to BYOC without a disk, a network, or a credential, and to run the same
suite in CI that you run against a live backend.

## Install

```bash
npm install @byoc/core @byoc/memory
```

## Usage

```ts
import { BYOC } from "@byoc/core";
import { MemoryProvider } from "@byoc/memory";

const provider = new MemoryProvider();
const storage = new BYOC({ provider });

await storage.connect();
await storage.writeText("reports/q3.md", "# Q3");

// Inspect what your code stored, without mocking anything.
expect(provider.size).toBe(1);
expect(Buffer.from(provider.snapshot()["reports/q3.md"]).toString()).toBe("# Q3");

provider.clear(); // between test cases
```

## Configuration

| Option | Type | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `quotaBytes` | `number` | none | Total capacity to report. Omit to report usage only |
| `streamChunkSize` | `number` | `65536` | Bytes per chunk from `download().stream`. Lower it to exercise a caller's chunk handling |

## Test helpers

| Member | Returns | Use |
| :--- | :--- | :--- |
| `size` | `number` | How many objects are stored |
| `snapshot()` | `Record<string, Uint8Array>` | Every stored path and its bytes |
| `clear()` | `void` | Drop everything, between test cases |

## It models a flat object store

Like S3 and R2, this provider has **no real folders**. It reports
`folders: false`, and `createFolder` raises `CAPABILITY_UNSUPPORTED` rather
than faking a folder with a key prefix. Paths still nest: `list("reports")`
returns everything one level under `reports/`.

That is deliberate. A test double whose capabilities differ from production
lets bugs through, so this one commits to the most common real shape. If your
production provider has real folders, use [`@byoc/local`](../local) as the
double instead — it reports `folders: true` and is backed by real directories.

## Capabilities

| Capability | Supported |
| :--- | :--- |
| `serverSideCopy` | yes |
| `quota` | yes |
| `folders` | no |
| `publicUrls` | no |
| `sharing` | no |
| `resumableUploads` | no |
| `versioning` | no |

Nothing is persisted: every instance starts empty and is discarded with the
process.

## License

Apache-2.0
