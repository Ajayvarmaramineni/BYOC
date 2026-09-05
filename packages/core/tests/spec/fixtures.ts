import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Loader for the shared cross-SDK conformance fixtures in /spec/fixtures.
 *
 * These files are the contract between BYOC SDK implementations. Every language
 * binding runs against the same JSON, so a fixture failure here means the
 * TypeScript SDK has drifted from the spec — fix the implementation, not the
 * fixture.
 */
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/fixtures");

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as T;
}

export interface PathNormalizationFixture {
  version: number;
  normalize: { cases: Array<{ name: string; input: string | null; expected: string }> };
  normalize_errors: { cases: Array<{ name: string; input: string; error_code: string }> };
  basename: { cases: Array<{ input: string; expected: string }> };
  dirname: { cases: Array<{ input: string; expected: string }> };
  split: { cases: Array<{ input: string; expected: string[] }> };
}

export interface PathEncodingFixture {
  version: number;
  rfc3986_uri_encode: {
    cases: Array<{ input: string; encode_slash: boolean; expected: string }>;
  };
  encode_path_segments: { cases: Array<{ input: string; expected: string }> };
}

export interface E2EEEnvelopeFixture {
  version: number;
  iteration_bounds: { min: number; max: number };
  vectors: Array<{
    name: string;
    version: string;
    passphrase: string;
    iterations: number;
    frame_size?: number;
    salt_hex: string;
    nonce_base_hex?: string;
    iv_hex: string;
    plaintext_utf8: string;
    derived_key_hex: string;
    tag_hex: string;
    ciphertext_hex: string;
    envelope_hex: string;
  }>;
  rejection_cases: Array<{
    name: string;
    mutate?: { offset: number; uint32_be?: number; ascii?: string };
    passphrase?: string;
    truncate_to?: number;
    expect_error: string;
  }>;
}
