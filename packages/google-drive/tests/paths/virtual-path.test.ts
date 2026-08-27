import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LruTtlPathCache,
  GoogleDrivePathResolver
} from "../../src/paths/virtual-path.js";
import { DriveHttpClient } from "../../src/api/http.js";
import { GoogleOAuthClient } from "../../src/auth/oauth-client.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("LruTtlPathCache", () => {
  it("stores and retrieves cached path mappings", () => {
    const cache = new LruTtlPathCache();
    cache.set("users/123/avatar.jpg", "file-id-123");
    expect(cache.get("users/123/avatar.jpg")).toBe("file-id-123");
  });

  it("returns undefined for expired entries", async () => {
    const cache = new LruTtlPathCache({ ttlMs: 10 });
    cache.set("temp/file.txt", "temp-id");

    expect(cache.get("temp/file.txt")).toBe("temp-id");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get("temp/file.txt")).toBeUndefined();
  });

  it("evicts least recently used items when maxSize is exceeded", () => {
    const cache = new LruTtlPathCache({ maxSize: 2 });
    cache.set("path1", "id1");
    cache.set("path2", "id2");

    // Access path1 so path2 becomes the oldest
    cache.get("path1");

    // Add path3 -> should evict path2
    cache.set("path3", "id3");

    expect(cache.get("path1")).toBe("id1");
    expect(cache.get("path2")).toBeUndefined(); // Evicted
    expect(cache.get("path3")).toBe("id3");
  });

  it("deletes and clears entries cleanly", () => {
    const cache = new LruTtlPathCache();
    cache.set("a", "1");
    cache.set("b", "2");

    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");

    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("GoogleDrivePathResolver", () => {
  let oauth: GoogleOAuthClient;
  let http: DriveHttpClient;
  let cache: LruTtlPathCache;
  let resolver: GoogleDrivePathResolver;

  beforeEach(() => {
    oauth = new GoogleOAuthClient({
      clientId: "test-client-id",
      session: { accessToken: "valid-token" }
    });
    http = new DriveHttpClient(oauth);
    cache = new LruTtlPathCache();
    resolver = new GoogleDrivePathResolver(http, "MyTestApp", cache);
  });

  it("resolves or creates root folder under Drive root", async () => {
    vi.spyOn(http, "listFiles").mockResolvedValueOnce({
      kind: "drive#fileList",
      files: [{ id: "root-folder-id-789", name: "MyTestApp", mimeType: "application/vnd.google-apps.folder" }]
    });

    const rootId = await resolver.ensureRootFolder();
    expect(rootId).toBe("root-folder-id-789");
    expect(http.listFiles).toHaveBeenCalledWith(
      expect.stringContaining("name = 'MyTestApp' and 'root' in parents"),
      1
    );

    // Second call should hit in-memory / cache without calling listFiles
    const cachedRootId = await resolver.ensureRootFolder();
    expect(cachedRootId).toBe("root-folder-id-789");
    expect(http.listFiles).toHaveBeenCalledTimes(1);
  });

  it("recursively creates intermediate folder hierarchies", async () => {
    vi.spyOn(http, "listFiles")
      // 1. Root folder check -> found
      .mockResolvedValueOnce({
        kind: "drive#fileList",
        files: [{ id: "root-id", name: "MyTestApp", mimeType: "application/vnd.google-apps.folder" }]
      })
      // 2. "users" folder check -> not found
      .mockResolvedValueOnce({ kind: "drive#fileList", files: [] })
      // 3. "123" folder check -> not found
      .mockResolvedValueOnce({ kind: "drive#fileList", files: [] });

    vi.spyOn(http, "createFolder")
      .mockResolvedValueOnce({ id: "users-folder-id", name: "users", mimeType: "application/vnd.google-apps.folder" })
      .mockResolvedValueOnce({ id: "123-folder-id", name: "123", mimeType: "application/vnd.google-apps.folder" });

    const parentId = await resolver.resolveParentFolderId("users/123/avatar.jpg");
    expect(parentId).toBe("123-folder-id");
    expect(http.createFolder).toHaveBeenCalledWith("users", "root-id");
    expect(http.createFolder).toHaveBeenCalledWith("123", "users-folder-id");
  });

  it("resolves duplicate filenames deterministically by choosing newest modifiedTime", async () => {
    vi.spyOn(resolver, "resolveParentFolderId").mockResolvedValue("parent-folder-id");

    vi.spyOn(http, "listFiles").mockResolvedValueOnce({
      kind: "drive#fileList",
      files: [
        { id: "old-file-id", name: "report.pdf", mimeType: "application/pdf", modifiedTime: "2026-01-01T00:00:00Z" },
        { id: "new-file-id", name: "report.pdf", mimeType: "application/pdf", modifiedTime: "2026-08-01T00:00:00Z" }
      ]
    });

    const resolvedId = await resolver.resolveFileId("documents/report.pdf");
    expect(resolvedId).toBe("new-file-id");
  });

  it("throws OBJECT_NOT_FOUND if file is missing and invalidates cache", async () => {
    vi.spyOn(resolver, "resolveParentFolderId").mockResolvedValue("parent-folder-id");
    vi.spyOn(http, "listFiles").mockResolvedValueOnce({
      kind: "drive#fileList",
      files: []
    });

    await expect(resolver.resolveFileId("missing.txt")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.OBJECT_NOT_FOUND
      })
    );
  });

  it("safely escapes single quotes and backslashes in filenames (Bug #5 fix)", async () => {
    vi.spyOn(resolver, "resolveParentFolderId").mockResolvedValue("parent-folder-id");
    vi.spyOn(http, "listFiles").mockResolvedValueOnce({
      kind: "drive#fileList",
      files: [{ id: "bob-file-id", name: "Bob's Resume.pdf", mimeType: "application/pdf" }]
    });

    const fileId = await resolver.resolveFileId("documents/Bob's Resume.pdf");
    expect(fileId).toBe("bob-file-id");

    expect(http.listFiles).toHaveBeenCalledWith(
      expect.stringContaining("name = 'Bob\\'s Resume.pdf' and 'parent-folder-id' in parents"),
      10
    );
  });
});
