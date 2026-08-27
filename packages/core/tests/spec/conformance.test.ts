import { describe, it, expect } from "vitest";
import {
  normalizeVirtualPath,
  getBasename,
  getDirname,
  splitPath,
  rfc3986UriEncode,
  encodePathSegments
} from "../../src/paths/resolver.js";
import { E2EECrypto } from "../../src/encryption/e2ee.js";
import { StorageError } from "../../src/errors/storage-error.js";
import {
  loadFixture,
  type PathNormalizationFixture,
  type PathEncodingFixture,
  type E2EEEnvelopeFixture
} from "./fixtures.js";

/**
 * Cross-SDK conformance suite.
 *
 * Every assertion here comes from /spec/fixtures — the same JSON the Python SDK
 * runs against. If both implementations pass this suite, a file written by one
 * can be read by the other.
 */

describe("Spec conformance: path normalization", () => {
  const fx = loadFixture<PathNormalizationFixture>("path-normalization.json");

  it.each(fx.normalize.cases)("normalize: $name", ({ input, expected }) => {
    const actual = input === null ? normalizeVirtualPath() : normalizeVirtualPath(input);
    expect(actual).toBe(expected);
  });

  it.each(fx.normalize_errors.cases)("rejects: $name", ({ input, error_code }) => {
    try {
      normalizeVirtualPath(input);
      throw new Error(`Expected ${error_code} but no error was thrown`);
    } catch (err) {
      expect(StorageError.isStorageError(err)).toBe(true);
      if (StorageError.isStorageError(err)) expect(err.code).toBe(error_code);
    }
  });

  it.each(fx.basename.cases)("basename($input)", ({ input, expected }) => {
    expect(getBasename(input)).toBe(expected);
  });

  it.each(fx.dirname.cases)("dirname($input)", ({ input, expected }) => {
    expect(getDirname(input)).toBe(expected);
  });

  it.each(fx.split.cases)("split($input)", ({ input, expected }) => {
    expect(splitPath(input)).toEqual(expected);
  });
});

describe("Spec conformance: RFC 3986 path encoding", () => {
  const fx = loadFixture<PathEncodingFixture>("path-encoding.json");

  it.each(fx.rfc3986_uri_encode.cases)(
    "rfc3986UriEncode($input, $encode_slash)",
    ({ input, encode_slash, expected }) => {
      expect(rfc3986UriEncode(input, encode_slash)).toBe(expected);
    }
  );

  it.each(fx.encode_path_segments.cases)("encodePathSegments($input)", ({ input, expected }) => {
    expect(encodePathSegments(input)).toBe(expected);
  });
});

describe("Spec conformance: E2EE envelope", () => {
  const fx = loadFixture<E2EEEnvelopeFixture>("e2ee-envelope.json");

  // Every vector must decrypt to its declared plaintext. This is the assertion
  // that makes encrypted files portable between SDKs.
  it.each(fx.vectors)("decrypts vector: $name", async (vec) => {
    const crypto = new E2EECrypto({ passphrase: vec.passphrase });
    const envelope = Uint8Array.from(Buffer.from(vec.envelope_hex, "hex"));
    const plaintext = await crypto.decrypt(envelope);
    expect(new TextDecoder().decode(plaintext)).toBe(vec.plaintext_utf8);
  });

  // The envelope layout itself is the contract, so assert the byte framing too:
  // a correct plaintext with a wrong layout would still break the other SDK.
  it.each(fx.vectors)("envelope framing matches spec: $name", (vec) => {
    const env = Buffer.from(vec.envelope_hex, "hex");
    const hasIter = vec.version === "V2";
    let offset = 0;

    expect(env.subarray(offset, offset + 12).toString()).toBe(`BYOC_E2EE_${vec.version}`);
    offset += 12;

    if (hasIter) {
      expect(env.subarray(offset, offset + 4).readUInt32BE(0)).toBe(vec.iterations);
      offset += 4;
    }

    expect(env.subarray(offset, offset + 16).toString("hex")).toBe(vec.salt_hex);
    offset += 16;
    expect(env.subarray(offset, offset + 12).toString("hex")).toBe(vec.iv_hex);
    offset += 12;
    expect(env.subarray(offset, offset + 16).toString("hex")).toBe(vec.tag_hex);
    offset += 16;
    expect(env.subarray(offset).toString("hex")).toBe(vec.ciphertext_hex);
  });

  it("round-trips its own output through the declared bounds", async () => {
    const crypto = new E2EECrypto({ passphrase: "spec-conformance-passphrase" });
    const envelope = await crypto.encrypt("round trip");
    expect(Buffer.from(envelope.subarray(0, 12)).toString()).toBe("BYOC_E2EE_V2");
    const iterations = Buffer.from(envelope.subarray(12, 16)).readUInt32BE(0);
    expect(iterations).toBeGreaterThanOrEqual(fx.iteration_bounds.min);
    expect(iterations).toBeLessThanOrEqual(fx.iteration_bounds.max);
    expect(new TextDecoder().decode(await crypto.decrypt(envelope))).toBe("round trip");
  });

  it.each(fx.rejection_cases)("rejects: $name", async (rc) => {
    const vec = fx.vectors.find((v) => v.version === "V2")!;
    let env = Buffer.from(vec.envelope_hex, "hex");

    if (rc.mutate) {
      env = Buffer.from(env);
      if (rc.mutate.uint32_be !== undefined) {
        env.writeUInt32BE(rc.mutate.uint32_be, rc.mutate.offset);
      }
      if (rc.mutate.ascii !== undefined) {
        Buffer.from(rc.mutate.ascii).copy(env, rc.mutate.offset);
      }
    }
    if (rc.truncate_to !== undefined) {
      env = env.subarray(0, rc.truncate_to);
    }

    const crypto = new E2EECrypto({ passphrase: rc.passphrase ?? vec.passphrase });
    const started = Date.now();
    await expect(crypto.decrypt(Uint8Array.from(env))).rejects.toThrowError(
      expect.objectContaining({ code: rc.expect_error })
    );
    // An out-of-range work factor must be refused before any key derivation runs.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
