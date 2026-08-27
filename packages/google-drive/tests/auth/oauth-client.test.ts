import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleOAuthClient } from "../../src/auth/oauth-client.js";
import { GoogleDriveScope } from "../../src/auth/types.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("GoogleOAuthClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws StorageError if clientId is missing", () => {
    expect(() => new GoogleOAuthClient({} as any)).toThrowError(StorageError);
  });

  it("constructs compliant Google OAuth authorization URL", () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id.apps.googleusercontent.com",
      redirectUri: "http://localhost:3000/callback"
    });

    const url = client.getAuthorizationUrl({
      state: "csrf-state-123",
      codeChallenge: "challenge-xyz",
      scopes: [GoogleDriveScope.FILE]
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("csrf-state-123");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges authorization code for access and refresh tokens", async () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:3000/callback"
    });

    const mockTokenResponse = {
      access_token: "mock-access-token-123",
      refresh_token: "mock-refresh-token-456",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/drive.file"
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTokenResponse
    });

    const session = await client.exchangeCode({
      code: "auth-code-789",
      codeVerifier: "code-verifier-abc"
    });

    expect(session.accessToken).toBe("mock-access-token-123");
    expect(session.refreshToken).toBe("mock-refresh-token-456");
    expect(session.expiresAt).toBeDefined();

    // Verify session stored
    const activeSession = await client.storage.get();
    expect(activeSession?.accessToken).toBe("mock-access-token-123");
  });

  it("returns active access token if still valid", async () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: {
        accessToken: "valid-token-abc",
        expiresAt: Date.now() + 1000 * 60 * 30 // 30 mins remaining
      }
    });

    const token = await client.getAccessToken();
    expect(token).toBe("valid-token-abc");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("automatically refreshes token when expired", async () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: {
        accessToken: "expired-token-old",
        refreshToken: "valid-refresh-token",
        expiresAt: Date.now() - 1000 * 60 // expired 1 minute ago
      }
    });

    const mockRefreshResponse = {
      access_token: "new-fresh-access-token",
      token_type: "Bearer",
      expires_in: 3600
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockRefreshResponse
    });

    const token = await client.getAccessToken();
    expect(token).toBe("new-fresh-access-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const stored = await client.storage.get();
    expect(stored?.accessToken).toBe("new-fresh-access-token");
    expect(stored?.refreshToken).toBe("valid-refresh-token"); // Preserved
  });

  it("throws TOKEN_EXPIRED if expired and no refresh token is present", async () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: {
        accessToken: "expired-token-old",
        expiresAt: Date.now() - 1000 * 60
      }
    });

    await expect(client.getAccessToken()).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.TOKEN_EXPIRED
      })
    );
  });

  it("revokes token and clears session on revoke()", async () => {
    const client = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: {
        accessToken: "token-to-revoke",
        refreshToken: "refresh-to-revoke"
      }
    });

    (global.fetch as any).mockResolvedValueOnce({ ok: true });

    await client.revoke();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://oauth2.googleapis.com/revoke?token=refresh-to-revoke"),
      expect.any(Object)
    );

    const session = await client.storage.get();
    expect(session).toBeNull();
  });

  it("stores and decrypts session using EncryptedFileTokenStorage (Bug #13 recipe)", async () => {
    const { EncryptedFileTokenStorage } = await import("../../src/auth/storage.js");
    const os = await import("node:os");
    const path = await import("node:path");

    const tempPath = path.join(os.tmpdir(), `byoc-token-test-${Date.now()}.json`);
    const storage = new EncryptedFileTokenStorage({
      filePath: tempPath,
      encryptionKey: "my-secure-app-secret-password-1234"
    });

    const mockSession = {
      accessToken: "secret-access-token-777",
      refreshToken: "secret-refresh-token-888",
      expiresAt: Date.now() + 3600 * 1000
    };

    storage.set(mockSession);

    // Read back and decrypt
    const restored = storage.get();
    expect(restored?.accessToken).toBe("secret-access-token-777");
    expect(restored?.refreshToken).toBe("secret-refresh-token-888");

    // Clean up
    storage.clear();
    expect(storage.get()).toBeNull();
  });
});
