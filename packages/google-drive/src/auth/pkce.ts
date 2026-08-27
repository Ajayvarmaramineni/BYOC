import { webcrypto } from "node:crypto";

const cryptoObj = (typeof crypto !== "undefined" ? crypto : webcrypto) as Crypto;

/**
 * Converts an ArrayBuffer to a base64url-encoded string (RFC 7636).
 */
function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generates a cryptographically random code_verifier string (43 to 128 characters).
 */
export function generateCodeVerifier(length: number = 64): string {
  const validLength = Math.max(43, Math.min(128, length));
  const randomBytes = new Uint8Array(validLength);
  cryptoObj.getRandomValues(randomBytes);
  return base64UrlEncode(randomBytes.buffer).substring(0, validLength);
}

/**
 * Generates an S256 code_challenge from a code_verifier (RFC 7636).
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await cryptoObj.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

/**
 * Generates a cryptographically secure random state string to protect against CSRF.
 */
export function generateOAuthState(length: number = 32): string {
  const randomBytes = new Uint8Array(length);
  cryptoObj.getRandomValues(randomBytes);
  return base64UrlEncode(randomBytes.buffer).substring(0, length);
}
