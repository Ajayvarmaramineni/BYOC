import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DriveHttpClient } from "../../src/api/http.js";
import { GoogleOAuthClient } from "../../src/auth/oauth-client.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("DriveHttpClient", () => {
  const originalFetch = global.fetch;
  let oauth: GoogleOAuthClient;
  let client: DriveHttpClient;

  beforeEach(() => {
    global.fetch = vi.fn();
    oauth = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: { accessToken: "valid-bearer-token" }
    });
    client = new DriveHttpClient(oauth);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("injects Authorization header into requests", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "123", name: "test.pdf" })
    });

    const file = await client.getFile("123");
    expect(file.id).toBe("123");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/files/123"),
      expect.objectContaining({
        headers: expect.any(Headers)
      })
    );
  });

  it("maps error responses using mapGoogleDriveError", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          code: 404,
          message: "File not found",
          errors: [{ reason: "notFound" }]
        }
      })
    });

    await expect(client.getFile("missing-id")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.OBJECT_NOT_FOUND
      })
    );
  });

  it("creates folders with folder mimeType", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "folder-456",
        name: "MyFolder",
        mimeType: "application/vnd.google-apps.folder"
      })
    });

    const folder = await client.createFolder("MyFolder", "parent-123");
    expect(folder.id).toBe("folder-456");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/files"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "MyFolder",
          mimeType: "application/vnd.google-apps.folder",
          parents: ["parent-123"]
        })
      })
    );
  });

  it("queries storage quota accurately", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        storageQuota: {
          limit: "15000000000",
          usage: "5000000000"
        }
      })
    });

    const about = await client.getAboutQuota();
    expect(about.storageQuota?.limit).toBe("15000000000");
    expect(about.storageQuota?.usage).toBe("5000000000");
  });
});
