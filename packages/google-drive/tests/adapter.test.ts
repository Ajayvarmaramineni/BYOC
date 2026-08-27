import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleDriveProvider } from "../src/adapter.js";
import { GoogleDriveScope } from "../src/auth/types.js";
import { StorageError, BYOCErrorCode } from "@byoc/core";

describe("GoogleDriveProvider REST API Operations", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("instantiates correctly with valid configuration", () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id.apps.googleusercontent.com",
        scopes: [GoogleDriveScope.FILE]
      },
      rootFolderName: "TestApp"
    });

    expect(provider).toBeDefined();
    expect(provider.config.rootFolderName).toBe("TestApp");
    expect(provider.oauth).toBeDefined();
  });

  it("throws StorageError if clientId is missing", () => {
    expect(() => new GoogleDriveProvider({ auth: {} as any })).toThrowError(StorageError);
  });

  it("exposes accurate provider manifest and capabilities", () => {
    const provider = new GoogleDriveProvider({
      auth: { clientId: "test-client-id" }
    });

    const manifest = provider.manifest();
    expect(manifest.id).toBe("google-drive");
    expect(manifest.name).toBe("Google Drive");
    expect(manifest.category).toBe("personal-cloud");

    const caps = provider.capabilities();
    expect(caps.folders).toBe(true);
    expect(caps.quota).toBe(true);
  });

  it("throws AUTH_REQUIRED on connect() if no session exists", async () => {
    const provider = new GoogleDriveProvider({
      auth: { clientId: "test-client-id" }
    });

    await expect(provider.connect()).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.AUTH_REQUIRED
      })
    );
  });

  it("connects and executes real REST upload", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      },
      rootFolderName: "TestApp"
    });

    // 1. Root folder lookup mock
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ id: "root-folder-id", name: "TestApp" }] })
    });

    await provider.connect();

    // 2. Upload file mock
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "uploaded-file-id-123",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: "1024",
        createdTime: new Date().toISOString()
      })
    });

    const result = await provider.upload("report.pdf", "PDF Data", { mimeType: "application/pdf" });
    expect(result.id).toBe("gdrive_uploaded-file-id-123");
    expect(result.path).toBe("report.pdf");
    expect(result.provider).toBe("google-drive");
  });

  it("executes list operations inside root folder", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    // Root folder lookup mock
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files: [{ id: "root-folder-id" }] })
    });

    // List files mock
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { id: "f1", name: "doc.txt", mimeType: "text/plain", size: "50" },
          { id: "f2", name: "Images", mimeType: "application/vnd.google-apps.folder" }
        ]
      })
    });

    const list = await provider.list();
    expect(list.length).toBe(2);
    expect(list[0]?.name).toBe("doc.txt");
    expect(list[0]?.type).toBe("file");
    expect(list[1]?.name).toBe("Images");
    expect(list[1]?.type).toBe("folder");
  });

  it("fetches quota from about endpoint", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        storageQuota: {
          limit: "107374182400", // 100 GB
          usage: "10737418240"    // 10 GB
        }
      })
    });

    const quota = await provider.quota();
    expect(quota.total).toBe(107374182400);
    expect(quota.used).toBe(10737418240);
    expect(quota.available).toBe(96636764160);
  });

  it("executes server-side copy in Google Drive using files.copy", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    vi.spyOn(provider.resolver, "resolveFileId").mockResolvedValueOnce("source-file-123");
    vi.spyOn(provider.resolver, "resolveParentFolderId").mockResolvedValueOnce("target-parent-456");
    vi.spyOn(provider.http, "copyFile").mockResolvedValueOnce({
      id: "copied-file-789",
      name: "report_copy.pdf"
    });

    await provider.copy("docs/report.pdf", "archive/report_copy.pdf");

    expect(provider.http.copyFile).toHaveBeenCalledWith(
      "source-file-123",
      "report_copy.pdf",
      "target-parent-456"
    );
  });

  it("executes server-side move in Google Drive using parent swapping", async () => {
    const provider = new GoogleDriveProvider({
      auth: {
        clientId: "test-client-id",
        session: { accessToken: "valid-token" }
      }
    });

    vi.spyOn(provider.resolver, "resolveFileId").mockResolvedValueOnce("file-to-move-123");
    vi.spyOn(provider.resolver, "resolveParentFolderId")
      .mockResolvedValueOnce("old-parent-111")
      .mockResolvedValueOnce("new-parent-222");
    vi.spyOn(provider.http, "moveFile").mockResolvedValueOnce({
      id: "file-to-move-123",
      name: "moved_report.pdf"
    });

    await provider.move("inbox/moved_report.pdf", "processed/moved_report.pdf");

    expect(provider.http.moveFile).toHaveBeenCalledWith(
      "file-to-move-123",
      "new-parent-222",
      "old-parent-111",
      "moved_report.pdf"
    );
  });
});
