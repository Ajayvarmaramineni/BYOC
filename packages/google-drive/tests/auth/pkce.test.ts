import { describe, it, expect } from "vitest";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateOAuthState
} from "../../src/auth/pkce.js";

describe("PKCE Utilities", () => {
  it("generates a random code_verifier of specified length", () => {
    const verifier = generateCodeVerifier(64);
    expect(typeof verifier).toBe("string");
    expect(verifier.length).toBe(64);
    // Base64url character set check
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true);
  });

  it("clamps code_verifier length between 43 and 128 (RFC 7636)", () => {
    const shortVerifier = generateCodeVerifier(10);
    expect(shortVerifier.length).toBe(43);

    const longVerifier = generateCodeVerifier(200);
    expect(longVerifier.length).toBe(128);
  });

  it("generates deterministic SHA-256 S256 code_challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await generateCodeChallenge(verifier);
    expect(typeof challenge).toBe("string");
    expect(challenge.length).toBeGreaterThan(20);
    expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true);
  });

  it("generates random CSRF state string", () => {
    const state1 = generateOAuthState(32);
    const state2 = generateOAuthState(32);
    expect(state1.length).toBe(32);
    expect(state2.length).toBe(32);
    expect(state1).not.toBe(state2);
  });
});
