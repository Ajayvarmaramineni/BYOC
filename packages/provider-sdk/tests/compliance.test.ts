import { describe, it, expect } from "vitest";
import { runProviderComplianceSuite } from "../src/compliance.js";
import type { BYOCProvider } from "@byoc/core";
import { StorageError, BYOCErrorCode } from "@byoc/core";

describe("Provider Certification SDK & Compliance Runner", () => {
  it("certifies a valid in-memory mock provider with 100% pass rate", async () => {
    const memoryFiles = new Map<string, { content: string; mimeType?: string }>();

    const mockProvider: BYOCProvider = {
      manifest: () => ({
        id: "in-memory-test",
        name: "In-Memory Test Adapter",
        category: "self-hosted",
        authentication: "api-key",
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
        memoryFiles.set(path, { content: String(data), mimeType: options?.mimeType });
        return {
          id: `mem_${path}`,
          path,
          name: path,
          provider: "in-memory-test",
          providerId: path
        };
      },
      download: async (path) => {
        const item = memoryFiles.get(path);
        if (!item) {
          throw new StorageError({
            code: BYOCErrorCode.OBJECT_NOT_FOUND,
            message: `File not found: ${path}`,
            provider: "in-memory-test"
          });
        }
        return {
          stream: null as any,
          text: async () => item.content,
          arrayBuffer: async () => new TextEncoder().encode(item.content).buffer,
          metadata: { id: `mem_${path}`, path, name: path, provider: "in-memory-test", providerId: path }
        };
      },
      delete: async (path) => {
        memoryFiles.delete(path);
      },
      list: async () => [],
      exists: async (path) => memoryFiles.has(path),
      metadata: async (path) => {
        const item = memoryFiles.get(path);
        if (!item) throw new StorageError({ code: BYOCErrorCode.OBJECT_NOT_FOUND, message: "Not found", provider: "in-memory-test" });
        return { id: `mem_${path}`, path, name: path, provider: "in-memory-test", providerId: path };
      },
      createFolder: async (path) => ({
        id: `folder_${path}`,
        path,
        name: path,
        provider: "in-memory-test",
        providerId: path,
        type: "folder"
      }),
      quota: async () => ({ total: 1000, used: 100, available: 900 })
    };

    const report = await runProviderComplianceSuite(() => mockProvider);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
  });
});
