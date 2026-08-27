import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleDriveProvider } from "../../src/adapter.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("Failure Injection & Hardening Test Suite", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("recovers from transient 429 rate limits via backoff and succeeds", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    // 1. Root folder query -> found
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ id: "root-folder-id" }] })
    });

    // 2. Upload attempt 1 -> 429 Rate Limit
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: { code: 429, message: "Rate limit exceeded", errors: [{ reason: "rateLimitExceeded" }] }
      })
    });

    // 3. Upload attempt 2 -> 200 Success
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "recovered-file-id",
        name: "resilient.pdf",
        mimeType: "application/pdf"
      })
    });

    const result = await provider.upload("resilient.pdf", "PDF Data");
    expect(result.id).toBe("gdrive_recovered-file-id");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on 403 quota exceeded without wasting retries", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    // 1. Root folder query -> found
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ id: "root-folder-id" }] })
    });

    // 2. Upload attempt -> 403 Quota Exceeded
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 403,
          message: "User storage quota exceeded",
          errors: [{ reason: "storageQuotaExceeded" }]
        }
      })
    });

    await expect(provider.upload("large.zip", "data")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.QUOTA_EXCEEDED,
        retryable: false
      })
    );

    // Ensure it did not retry on quota error
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("transparently refreshes expired token during operation", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: {
          accessToken: "expired-token-123",
          refreshToken: "valid-refresh-token",
          expiresAt: Date.now() - 1000 * 60 // Expired 1 min ago
        }
      }
    });

    // 1. OAuth refresh endpoint call
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-fresh-access-token",
        expires_in: 3600
      })
    });

    // 2. Metadata getFile query using fresh token
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "meta-id-123",
        name: "file.txt",
        mimeType: "text/plain"
      })
    });

    // Setup cached file ID so resolveFileId doesn't query root folder
    await provider.resolver.setCached("file.txt", "meta-id-123");

    const meta = await provider.metadata("file.txt");
    expect(meta.id).toBe("gdrive_meta-id-123");

    // Verify fresh token was requested
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://oauth2.googleapis.com/token"),
      expect.any(Object)
    );
  });
});
