/**
 * Tests for the direct-upload client.
 *
 * These exercise the consumer half of the UploadGrant contract in
 * spec/fixtures/upload-grant.json. The producer half is asserted by each
 * server SDK against the same fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { UploadGrant } from "@byoc/core";
import { uploadWithGrant, reviveGrant, DirectUploadError } from "../src/upload.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "../../../spec/fixtures/upload-grant.json"), "utf-8")
);

function makeGrant(overrides: Partial<UploadGrant> = {}): UploadGrant {
  return {
    provider: "s3-compatible",
    path: "photos/a.jpg",
    url: "https://example.com/bucket/photos/a.jpg?X-Amz-Signature=abc",
    method: "PUT",
    headers: {},
    protocol: "single",
    expiresAt: new Date(Date.now() + 300_000),
    ...overrides
  };
}

describe("uploadWithGrant", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockOnce(status: number, body = ""): void {
    (global.fetch as any).mockResolvedValueOnce({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      headers: new Headers()
    });
  }

  it("sends the body to the grant's url with its method and headers", async () => {
    mockOnce(200);
    const grant = makeGrant({ headers: { "x-required": "yes" } });

    await uploadWithGrant(grant, "hello");

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(grant.url);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "x-required": "yes" });
  });

  it("reports progress reaching 100%", async () => {
    mockOnce(200);
    const seen: number[] = [];

    await uploadWithGrant(makeGrant(), "hello", {
      onProgress: (p) => seen.push(p.percentage)
    });

    expect(seen.at(-1)).toBe(100);
  });

  it("refuses an expired grant before sending anything", async () => {
    const expired = makeGrant({ expiresAt: new Date(Date.now() - 1000) });

    await expect(uploadWithGrant(expired, "hello")).rejects.toThrow(DirectUploadError);
    // The point is that no request is attempted at all.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("marks an expiry failure as expired so callers can re-request", async () => {
    const expired = makeGrant({ expiresAt: new Date(Date.now() - 1000) });

    await uploadWithGrant(expired, "x").catch((error: DirectUploadError) => {
      expect(error.expired).toBe(true);
    });
  });

  it("retries a transient failure and then succeeds", async () => {
    mockOnce(503, "slow down");
    mockOnce(200);

    await uploadWithGrant(makeGrant(), "hello", { maxAttempts: 2 });

    expect((global.fetch as any).mock.calls.length).toBe(2);
  });

  it("does not retry a 403, because an expired signature cannot recover", async () => {
    mockOnce(403, "SignatureDoesNotMatch");

    await expect(
      uploadWithGrant(makeGrant(), "hello", { maxAttempts: 5 })
    ).rejects.toThrow(/403/);
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it("rejects a body larger than the grant allows", async () => {
    const grant = makeGrant({ maxBytes: 4 });

    await expect(uploadWithGrant(grant, "far too long")).rejects.toThrow(/at most 4/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats a null maxBytes as absent", async () => {
    // Regression: a Python producer emitting "maxBytes": null made every
    // upload fail, because `size > null` coerces to `size > 0` in JavaScript.
    mockOnce(200);
    const grant = makeGrant({ maxBytes: null as unknown as number });

    await expect(uploadWithGrant(grant, "hello")).resolves.toBeUndefined();
  });

  it("chunks a resumable upload with Content-Range", async () => {
    mockOnce(308);
    mockOnce(200);
    const grant = makeGrant({ protocol: "resumable", chunkSize: 4 });

    await uploadWithGrant(grant, "abcdefg");

    const ranges = (global.fetch as any).mock.calls.map(
      ([, init]: [string, any]) => init.headers["Content-Range"]
    );
    expect(ranges).toEqual(["bytes 0-3/7", "bytes 4-6/7"]);
  });
});

describe("reviveGrant", () => {
  it("turns a JSON expiresAt string back into a Date", async () => {
    const wire = JSON.parse(JSON.stringify(makeGrant()));
    expect(typeof wire.expiresAt).toBe("string");

    expect(reviveGrant(wire).expiresAt).toBeInstanceOf(Date);
  });

  it("treats a missing expiry as already expired, not as eternal", () => {
    // Failing closed is the only safe reading of a missing bound on a
    // bearer capability.
    const rule = fixture.field_rules.expiresAt.on_absent;
    expect(rule).toBe("treat as already expired");

    const revived = reviveGrant({ ...makeGrant(), expiresAt: undefined });

    expect(revived.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("rejects an object that is not a grant", () => {
    expect(() => reviveGrant({ nope: true })).toThrow(DirectUploadError);
  });

  it("accepts every required wire key named by the fixture", () => {
    const wire = JSON.parse(JSON.stringify(makeGrant()));

    for (const key of fixture.wire_keys.required) {
      expect(wire, `wire form is missing '${key}'`).toHaveProperty(key);
    }
  });
});
