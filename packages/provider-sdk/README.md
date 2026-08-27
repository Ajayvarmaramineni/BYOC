# @byoc/provider-sdk

Certification suite for **BYOC (Bring Your Own Cloud)** provider adapters: verify that a custom storage adapter behaves the way `@byoc/core` expects before you ship it.

> Part of the [BYOC monorepo](https://github.com/Ajayvarmaramineni/BYOC). Requires `@byoc/core`.
>
> **Status: v0.2.0.**

## Install

```bash
npm install --save-dev @byoc/provider-sdk
```

## Usage

Point the suite at a factory that returns your adapter. It exercises the full `BYOCProvider` contract against a live instance and returns a structured report.

```ts
import { runProviderComplianceSuite } from "@byoc/provider-sdk";
import { MyCustomProvider } from "./my-provider.js";

const report = await runProviderComplianceSuite(
  () => new MyCustomProvider({ /* ... */ })
);

console.log(`${report.passed}/${report.total} passed`);

for (const result of report.results) {
  if (!result.passed) console.error(`✗ ${result.name}: ${result.error}`);
}
```

Adapters that legitimately lack a capability can skip those assertions:

```ts
await runProviderComplianceSuite(factory, {
  skipQuota: true,    // provider has no quota concept (e.g. S3)
  skipFolders: true   // provider has no explicit folders
});
```

## What it checks

Manifest structure, capability declarations, the connect/disconnect lifecycle, upload and download round-trips, metadata and `exists()` accuracy, listing, deletion, and correct `StorageError` codes for missing objects and unsupported capabilities.

## Report shape

```ts
interface ComplianceReport {
  providerId: string;
  providerName: string;
  total: number;
  passed: number;
  failed: number;
  results: Array<{
    name: string;
    passed: boolean;
    error?: string;
    durationMs: number;
  }>;
}
```

The suite catches per-test failures rather than throwing, so one broken operation still produces a full report. `vitest` is an optional peer dependency; the suite runs standalone and doesn't require a test runner.

## License

[Apache-2.0](./LICENSE)
