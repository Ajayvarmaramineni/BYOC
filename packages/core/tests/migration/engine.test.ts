import { describe, it, expect, vi } from "vitest";
import { BYOC } from "../../src/client/byoc.js";
import { MigrationEngine } from "../../src/migration/engine.js";
import type { BYOCProvider } from "../../src/types/provider.js";

function createMemoryProvider(id: string, name: string): BYOCProvider {
  const store = new Map<string, { content: string; mimeType?: string }>();

  return {
    manifest: () => ({
      id,
      name,
      category: "self-hosted",
      authentication: "basic",
      supportsUserOwnedStorage: true,
      adapterVersion: "1.0.0"
    }),
    capabilities: () => ({
      folders: true,
      sharing: false,
      publicUrls: false,
      resumableUploads: false,
      versioning: false,
      quota: true,
      serverSideCopy: false
    }),
    connect: async () => {},
    disconnect: async () => {},
    upload: async (path, data, options) => {
      let contentStr = "";
      if (typeof data === "string") {
        contentStr = data;
      } else if (data instanceof ArrayBuffer) {
        contentStr = new TextDecoder().decode(data);
      } else if (data instanceof Uint8Array) {
        contentStr = new TextDecoder().decode(data);
      } else {
        contentStr = String(data);
      }
      store.set(path, { content: contentStr, mimeType: options?.mimeType });
      return { id: `${id}_${path}`, path, name: path, provider: id, providerId: path, size: contentStr.length };
    },
    download: async (path) => {
      const item = store.get(path);
      if (!item) throw new Error(`Not found: ${path}`);
      return {
        stream: null as any,
        text: async () => item.content,
        arrayBuffer: async () => new TextEncoder().encode(item.content).buffer,
        metadata: { id: `${id}_${path}`, path, name: path, provider: id, providerId: path, size: item.content.length, mimeType: item.mimeType }
      };
    },
    delete: async (path) => {
      store.delete(path);
    },
    list: async () => [],
    exists: async (path) => store.has(path),
    metadata: async (path) => {
      const item = store.get(path);
      if (!item) throw new Error(`Not found: ${path}`);
      return { id: `${id}_${path}`, path, name: path, provider: id, providerId: path, size: item.content.length };
    }
  };
}

describe("Universal Migration Engine", () => {
  it("migrates files from source provider to target provider with progress tracking", async () => {
    const source = createMemoryProvider("google-drive", "Google Drive");
    const target = createMemoryProvider("cloudflare-r2", "Cloudflare R2");

    // Populate source files
    await source.upload("users/1/avatar.png", "PNG Data");
    await source.upload("documents/contract.pdf", "PDF Data");
    await source.upload("notes.txt", "Text Data");

    const progressLogs: any[] = [];

    const report = await MigrationEngine.migrate({
      source,
      target,
      paths: ["users/1/avatar.png", "documents/contract.pdf", "notes.txt"],
      conflictStrategy: "overwrite",
      onProgress: (p) => progressLogs.push(p)
    });

    expect(report.filesTotal).toBe(3);
    expect(report.filesMigrated).toBe(3);
    expect(report.filesFailed).toBe(0);
    expect(progressLogs.length).toBe(3);
    expect(progressLogs[2]?.percentage).toBe(100);

    // Verify files now exist on target
    expect(await target.exists("users/1/avatar.png")).toBe(true);
    expect(await target.exists("documents/contract.pdf")).toBe(true);
    expect(await target.exists("notes.txt")).toBe(true);

    const doc = await target.download("documents/contract.pdf");
    expect(await doc.text()).toBe("PDF Data");
  });

  it("orchestrates migration through the BYOC client instance", async () => {
    const drive = createMemoryProvider("google-drive", "Google Drive");
    const nextcloud = createMemoryProvider("webdav", "Nextcloud");

    await drive.upload("database/dump.sql.gz", "SQL GZIP DATA");

    const client = new BYOC({
      providers: [drive, nextcloud]
    });

    const report = await client.migrate({
      from: "google-drive",
      to: "webdav",
      paths: ["database/dump.sql.gz"],
      deleteSourceAfterMigrate: true
    });

    expect(report.filesMigrated).toBe(1);
    expect(await nextcloud.exists("database/dump.sql.gz")).toBe(true);
    // Source was deleted
    expect(await drive.exists("database/dump.sql.gz")).toBe(false);
  });

  it("reports 'partial' without double-counting if source deletion fails", async () => {
    const drive = createMemoryProvider("google-drive", "Google Drive");
    const nextcloud = createMemoryProvider("webdav", "Nextcloud");

    // Make delete throw an error
    drive.delete = async () => {
      throw new Error("Permission Denied: Cannot delete from read-only source");
    };

    await drive.upload("vault/key.pem", "SECRET KEY");

    const report = await MigrationEngine.migrate({
      source: drive,
      target: nextcloud,
      paths: ["vault/key.pem"],
      deleteSourceAfterMigrate: true
    });

    expect(report.filesTotal).toBe(1);
    expect(report.filesMigrated).toBe(0);
    expect(report.filesFailed).toBe(0);
    expect(report.filesPartial).toBe(1);
    // Exactly one record for one input file — no double-counting
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.status).toBe("partial");
    expect(report.results[0]?.error).toContain("Permission Denied");

    // The whole point of 'partial': the copy really did land on the target
    expect(await nextcloud.exists("vault/key.pem")).toBe(true);
    expect(await (await nextcloud.download("vault/key.pem")).text()).toBe("SECRET KEY");
    // ...and the source copy is still there, awaiting cleanup
    expect(await drive.exists("vault/key.pem")).toBe(true);
  });

  it("still reports 'failed' when the target upload itself fails", async () => {
    const drive = createMemoryProvider("google-drive", "Google Drive");
    const nextcloud = createMemoryProvider("webdav", "Nextcloud");

    nextcloud.upload = async () => {
      throw new Error("Quota Exceeded: target is full");
    };

    await drive.upload("vault/key.pem", "SECRET KEY");

    const report = await MigrationEngine.migrate({
      source: drive,
      target: nextcloud,
      paths: ["vault/key.pem"],
      deleteSourceAfterMigrate: true
    });

    expect(report.filesFailed).toBe(1);
    expect(report.filesPartial).toBe(0);
    expect(report.results[0]?.status).toBe("failed");
    // A real transfer failure must never delete the source
    expect(await drive.exists("vault/key.pem")).toBe(true);
  });
});
