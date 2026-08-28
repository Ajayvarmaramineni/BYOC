/**
 * Conformance: the operation surface both SDKs must expose.
 *
 * Pins which operations exist, not which bytes they write. The byte-level
 * fixtures cannot catch a missing method, because an adapter that lacks
 * `copy()` still writes identical bytes for everything it does implement.
 * That gap is how three working `copy()` implementations shipped in 0.2.x
 * with no way for a caller to reach any of them.
 *
 * The fixture names operations in snake_case as the neutral form. Method
 * naming is deliberately not part of the cross-SDK contract, so this file
 * camelCases them on the way in.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { BYOC, type BYOCProvider } from "@byoc/core";
import { GoogleDriveProvider } from "../../google-drive/src/adapter.js";
import { S3CompatibleProvider } from "../../s3-compatible/src/adapter.js";
import { WebDAVProvider } from "../../webdav/src/adapter.js";
import { LocalFileSystemProvider } from "../../local/src/adapter.js";
import { MemoryProvider } from "../../memory/src/adapter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(HERE, "../../../spec/fixtures/provider-operations.json");

interface ProviderSpec {
  operations: string[];
  capabilities: Record<string, boolean>;
}

interface Fixture {
  client_operations: { required: string[] };
  provider_operations: { required: string[]; optional: string[] };
  capability_contracts: { contracts: { capability: string; requires_operation: string }[] };
  providers: Record<string, ProviderSpec>;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;

/**
 * Neutral operation names whose idiomatic TypeScript spelling is not a
 * mechanical case transform. `bytes` is the natural Python word; `Buffer` is
 * the natural Node one. Method naming is deliberately outside the cross-SDK
 * contract, so the mapping lives here in the SDK's own test rather than in
 * the shared fixture.
 */
const NAME_OVERRIDES: Record<string, string> = {
  read_bytes: "readBuffer",
  write_bytes: "writeBuffer",
  signed_url: "getSignedUrl"
};

/** snake_case neutral form -> this SDK's camelCase convention. */
function toCamel(name: string): string {
  return (
    NAME_OVERRIDES[name] ??
    name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  );
}

function has(target: object, operation: string): boolean {
  return typeof (target as Record<string, unknown>)[toCamel(operation)] === "function";
}

// Constructed with placeholder credentials: nothing here performs I/O, and
// every assertion is about the shape of the adapter rather than its behaviour.
const ADAPTERS: Record<string, BYOCProvider> = {
  "google-drive": new GoogleDriveProvider({
    auth: {
      clientId: "test.apps.googleusercontent.com",
      redirectUri: "http://localhost/callback"
    }
  }),
  "s3-compatible": new S3CompatibleProvider({
    endpoint: "http://127.0.0.1:9000",
    bucket: "test",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret"
  }),
  webdav: new WebDAVProvider({
    endpoint: "http://127.0.0.1:8080",
    username: "user",
    password: "pass"
  }),
  local: new LocalFileSystemProvider({ rootDirectory: "/tmp/byoc-conformance-shape-only" }),
  memory: new MemoryProvider()
};

const PROVIDER_IDS = Object.keys(fixture.providers)
  .filter((name) => !name.startsWith("$"))
  .sort();

describe("operation-surface conformance", () => {
  it.each(fixture.client_operations.required)(
    "the client exposes the required operation %s",
    (operation) => {
      // An adapter method the client does not expose is unreachable by callers.
      const client = new BYOC({ provider: new MemoryProvider() });

      expect(
        has(client, operation),
        `BYOC is missing the required operation '${toCamel(operation)}'. An operation ` +
          "implemented on adapters but absent from the client cannot be called by anyone."
      ).toBe(true);
    }
  );

  describe.each(PROVIDER_IDS)("adapter %s", (providerId) => {
    const adapter = ADAPTERS[providerId]!;
    const spec = fixture.providers[providerId]!;

    it.each(fixture.provider_operations.required)("implements required %s", (operation) => {
      expect(
        has(adapter, operation),
        `Adapter '${providerId}' is missing required operation '${toCamel(operation)}'.`
      ).toBe(true);
    });

    it("has an optional-operation surface matching the fixture", () => {
      // Catches an adapter drifting ahead of or behind its peer SDK.
      const actual = fixture.provider_operations.optional
        .filter((operation) => has(adapter, operation))
        .sort();

      expect(
        actual,
        `Adapter '${providerId}' optional operations do not match the fixture. Either ` +
          "implement the missing operation or update " +
          "spec/fixtures/provider-operations.json in both SDKs."
      ).toEqual([...spec.operations].sort());
    });

    it("declares the capabilities the fixture pins", async () => {
      const capabilities = (await adapter.capabilities()) as unknown as Record<string, boolean>;

      for (const [neutralFlag, expected] of Object.entries(spec.capabilities)) {
        const flag = toCamel(neutralFlag);
        expect(
          capabilities[flag],
          `Adapter '${providerId}' declares ${flag}=${capabilities[flag]}, but the ` +
            `cross-SDK fixture pins ${expected}.`
        ).toBe(expected);
      }
    });

    it.each(fixture.capability_contracts.contracts)(
      "backs a declared $capability with a real method",
      async ({ capability, requires_operation: operation }) => {
        // Declaring a capability without the method is a lie to feature detection.
        const capabilities = (await adapter.capabilities()) as unknown as Record<string, boolean>;
        if (!capabilities[toCamel(capability)]) return;

        expect(
          has(adapter, operation),
          `Adapter '${providerId}' declares ${capability}=true but has no ` +
            `'${toCamel(operation)}' method. Callers feature-detect on the capability ` +
            "and would hit an undefined-is-not-a-function instead of a clean " +
            "CAPABILITY_UNSUPPORTED error."
        ).toBe(true);
      }
    );
  });
});
