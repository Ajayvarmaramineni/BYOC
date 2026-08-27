import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResumableUploader, GOOGLE_DRIVE_CHUNK_ALIGNMENT } from "../../src/api/resumable.js";
import { GoogleOAuthClient } from "../../src/auth/oauth-client.js";

describe("ResumableUploader", () => {
  const originalFetch = global.fetch;
  let oauth: GoogleOAuthClient;
  let uploader: ResumableUploader;

  beforeEach(() => {
    global.fetch = vi.fn();
    oauth = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: { accessToken: "valid-token" }
    });
    uploader = new ResumableUploader(oauth);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("initiates upload session and transmits chunks to completion", async () => {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session123";

    // 1. Session initiation response
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ Location: sessionUri })
    });

    // Create 512 KiB data payload (2 * 256 KiB chunks)
    const payload = new Uint8Array(GOOGLE_DRIVE_CHUNK_ALIGNMENT * 2);
    payload.fill(65); // Fill with 'A'

    // 2. Chunk 1 PUT response -> 308 Resume Incomplete
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 308,
      headers: new Headers({ Range: `bytes=0-${GOOGLE_DRIVE_CHUNK_ALIGNMENT - 1}` })
    });

    // 3. Chunk 2 PUT response -> 200 Complete
    const finalResource = {
      id: "final-gdrive-file-id",
      name: "big-file.bin",
      size: String(payload.byteLength),
      mimeType: "application/octet-stream"
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => finalResource
    });

    const progressEvents: any[] = [];

    const result = await uploader.upload(
      { name: "big-file.bin" },
      payload,
      {
        chunkSize: GOOGLE_DRIVE_CHUNK_ALIGNMENT,
        onProgress: (p) => progressEvents.push(p)
      }
    );

    expect(result.id).toBe("final-gdrive-file-id");
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0]?.percentage).toBe(50);
    expect(progressEvents[1]?.percentage).toBe(100);

    // Verify initiation headers
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("uploadType=resumable"),
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers)
      })
    );

    // Verify chunk 1 headers
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      sessionUri,
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes 0-${GOOGLE_DRIVE_CHUNK_ALIGNMENT - 1}/${payload.byteLength}`
        }
      })
    );
  });

  it("handles 0-byte empty file upload", async () => {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=empty123";

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ Location: sessionUri })
    });

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "empty-file-id", name: "empty.txt", size: "0" })
    });

    const result = await uploader.upload({ name: "empty.txt" }, "");
    expect(result.id).toBe("empty-file-id");
  });
});
