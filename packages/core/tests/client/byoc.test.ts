import { describe, it, expect, vi } from "vitest";
import { BYOC } from "../../src/client/byoc.js";
import type { BYOCProvider, ProviderCapabilities, ProviderManifest } from "../../src/types/provider.js";
import type { StorageObject, StorageOutput, StorageQuota } from "../../src/types/storage.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";
import { StorageError } from "../../src/errors/storage-error.js";

function createMockProvider(overrides: Partial<BYOCProvider> = {}): BYOCProvider {
  const manifest: ProviderManifest = {
    id: "mock-storage",
    name: "Mock Storage",
    category: "self-hosted",
    authentication: "basic",
    supportsUserOwnedStorage: true,
    adapterVersion: "1.0.0"
  };

  const capabilities: ProviderCapabilities = {
    folders: true,
    sharing: false,
    publicUrls: false,
    resumableUploads: true,
    versioning: false,
    quota: true,
    serverSideCopy: false
  };

  return {
    manifest: () => manifest,
    capabilities: () => capabilities,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockImplementation(async (path: string, _data: any, options?: any) => ({
      id: "mock_id",
      path,
      name: "file.txt",
      provider: manifest.id,
      providerId: "mock_p_id",
      mimeType: options?.mimeType
    })),
    download: vi.fn().mockResolvedValue({
      text: async () => "file content text",
      arrayBuffer: async () => new ArrayBuffer(8),
      metadata: { id: "mock_id", path: "file.txt", name: "file.txt", provider: "mock-storage", providerId: "mock_p_id" }
    } as StorageOutput),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(true),
    metadata: vi.fn().mockImplementation(async (path: string) => ({
      id: "mock_id",
      path,
      name: "file.txt",
      provider: manifest.id,
      providerId: "mock_p_id"
    })),
    createFolder: vi.fn().mockImplementation(async (path: string) => ({
      id: "folder_id",
      path,
      name: "folder",
      provider: manifest.id,
      providerId: "mock_folder_id",
      type: "folder"
    })),
    quota: vi.fn().mockResolvedValue({ total: 1000, used: 100, available: 900 } as StorageQuota),
    ...overrides
  };
}

describe("BYOC Client & Multi-Provider Registry", () => {
  it("throws error if initialized without any provider", () => {
    expect(() => new BYOC({} as any)).toThrowError(StorageError);
    expect(() => new BYOC({ providers: [] } as any)).toThrowError(StorageError);
  });

  it("exposes provider manifest and capability helpers", async () => {
    const provider = createMockProvider();
    const storage = new BYOC({ provider });

    expect(storage.manifest().id).toBe("mock-storage");
    expect(await storage.hasCapability("folders")).toBe(true);
    expect(await storage.hasCapability("publicUrls")).toBe(false);
  });

  it("supports multi-provider registry and dynamic switching", () => {
    const driveProvider = createMockProvider({
      manifest: () => ({
        id: "google-drive",
        name: "Google Drive",
        category: "personal-cloud",
        authentication: "oauth2",
        supportsUserOwnedStorage: true,
        adapterVersion: "1.0.0"
      })
    });

    const s3Provider = createMockProvider({
      manifest: () => ({
        id: "cloudflare-r2",
        name: "Cloudflare R2",
        category: "developer-cloud",
        authentication: "access-key",
        supportsUserOwnedStorage: false,
        adapterVersion: "1.0.0"
      })
    });

    const storage = new BYOC({
      providers: [driveProvider, s3Provider],
      defaultProviderId: "google-drive"
    });

    // 1. Initial provider is Google Drive
    expect(storage.manifest().id).toBe("google-drive");
    expect(storage.getProviders().length).toBe(2);

    // 2. Switch to Cloudflare R2
    storage.useProvider("cloudflare-r2");
    expect(storage.manifest().id).toBe("cloudflare-r2");

    // 3. Switch to unregistered provider throws
    expect(() => storage.useProvider("unknown-provider")).toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.INVALID_INPUT })
    );
  });

  it("supports convenience read/write text and buffer shortcuts", async () => {
    const provider = createMockProvider();
    const storage = new BYOC({ provider });

    // writeText
    const written = await storage.writeText("notes/meeting.md", "# Notes");
    expect(provider.upload).toHaveBeenCalledWith(
      "notes/meeting.md",
      "# Notes",
      expect.objectContaining({ mimeType: "text/markdown" })
    );
    expect(written).toBeDefined();

    // readText
    const text = await storage.readText("notes/meeting.md");
    expect(text).toBe("file content text");

    // readBuffer
    const buffer = await storage.readBuffer("notes/meeting.md");
    expect(buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("normalizes paths before delegating to provider", async () => {
    const provider = createMockProvider();
    const storage = new BYOC({ provider });

    await storage.upload("///documents//report.pdf//", "content");
    expect(provider.upload).toHaveBeenCalledWith("documents/report.pdf", "content", {
      mimeType: "application/pdf"
    });

    await storage.download("\\images\\photo.png");
    expect(provider.download).toHaveBeenCalledWith("images/photo.png");

    await storage.delete("  temp//data.json  ");
    expect(provider.delete).toHaveBeenCalledWith("temp/data.json");
  });

  it("throws INVALID_INPUT if empty path is provided to upload or download", async () => {
    const provider = createMockProvider();
    const storage = new BYOC({ provider });

    await expect(storage.upload("", "content")).rejects.toThrowError(StorageError);
    await expect(storage.download("   ")).rejects.toThrowError(StorageError);
  });

  it("throws CAPABILITY_UNSUPPORTED when an unsupported optional method is invoked", async () => {
    const providerWithoutQuota = createMockProvider({
      capabilities: () => ({
        folders: false,
        sharing: false,
        publicUrls: true,
        resumableUploads: true,
        versioning: true,
        quota: false,
        serverSideCopy: true
      }),
      quota: undefined,
      createFolder: undefined
    });

    const storage = new BYOC({ provider: providerWithoutQuota });

    await expect(storage.getQuota()).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED
      })
    );

    await expect(storage.createFolder("new-dir")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED
      })
    );
  });

  it("runs backup helper successfully via upload fallback", async () => {
    const provider = createMockProvider({ backup: undefined });
    const storage = new BYOC({ provider });

    const result = await storage.backup(Buffer.from("backup-data"), {
      filename: "db-dump.sql.gz",
      folder: "DatabaseBackups"
    });

    expect(provider.upload).toHaveBeenCalledWith(
      "DatabaseBackups/db-dump.sql.gz",
      expect.any(Buffer),
      expect.objectContaining({ mimeType: "application/gzip" })
    );
    expect(result).toBeDefined();
  });
});
