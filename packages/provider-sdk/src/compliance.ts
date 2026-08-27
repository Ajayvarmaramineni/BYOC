import type { BYOCProvider } from "@byoc/core";
import { BYOCErrorCode, StorageError } from "@byoc/core";

export interface ComplianceSuiteOptions {
  /** Skip quota assertions if provider does not support it */
  skipQuota?: boolean;
  /** Skip folder creation assertions if provider does not support explicit folders */
  skipFolders?: boolean;
}

export interface ComplianceTestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface ComplianceReport {
  providerId: string;
  providerName: string;
  total: number;
  passed: number;
  failed: number;
  results: ComplianceTestResult[];
}

/**
 * Executes standard BYOC Provider Compliance & Certification Test Suite against any BYOCProvider.
 */
export async function runProviderComplianceSuite(
  providerFactory: () => Promise<BYOCProvider> | BYOCProvider,
  options: ComplianceSuiteOptions = {}
): Promise<ComplianceReport> {
  const provider = await providerFactory();
  const manifest = provider.manifest();
  const capabilities = await provider.capabilities();

  const results: ComplianceTestResult[] = [];

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (err) {
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start
      });
    }
  }

  // 1. Manifest Structure Validation
  await test("Manifest: Validates required metadata fields", async () => {
    if (!manifest.id || typeof manifest.id !== "string") throw new Error("Manifest 'id' is required.");
    if (!manifest.name || typeof manifest.name !== "string") throw new Error("Manifest 'name' is required.");
    if (!manifest.category) throw new Error("Manifest 'category' is required.");
    if (!manifest.authentication) throw new Error("Manifest 'authentication' is required.");
  });

  // 2. Capability Structure Validation
  await test("Capabilities: Declares standard boolean feature flags", async () => {
    if (typeof capabilities.folders !== "boolean") throw new Error("Capability 'folders' must be a boolean.");
    if (typeof capabilities.resumableUploads !== "boolean") throw new Error("Capability 'resumableUploads' must be a boolean.");
    if (typeof capabilities.quota !== "boolean") throw new Error("Capability 'quota' must be a boolean.");
  });

  // 3. Connect & Initialize
  await test("Lifecycle: connect() initializes without throwing", async () => {
    await provider.connect();
  });

  // 4. Basic File Upload & Verification
  const testFilename = `compliance-test-${Date.now()}.txt`;
  const testContent = "BYOC Compliance Verification Payload 12345";

  await test("Storage: upload() stores content and returns StorageObject", async () => {
    const obj = await provider.upload(testFilename, testContent, { mimeType: "text/plain" });
    if (!obj.id) throw new Error("Uploaded object must have a non-empty 'id'.");
    if (obj.name !== testFilename) throw new Error(`Expected name '${testFilename}', received '${obj.name}'`);
    if (obj.provider !== manifest.id) throw new Error(`Expected provider '${manifest.id}', received '${obj.provider}'`);
  });

  // 5. Download & Content Verification
  await test("Storage: download() returns valid text and metadata", async () => {
    const output = await provider.download(testFilename);
    const text = await output.text();
    if (text !== testContent) throw new Error(`Downloaded content '${text}' did not match original '${testContent}'`);
    if (output.metadata.name !== testFilename) throw new Error("Metadata mismatch on download.");
  });

  // 6. Metadata Inspection
  await test("Storage: metadata() returns accurate properties", async () => {
    const meta = await provider.metadata(testFilename);
    if (meta.name !== testFilename) throw new Error("metadata() returned incorrect file name.");
  });

  // 7. Existence Check
  await test("Storage: exists() returns true for present files and false for missing files", async () => {
    const existsPresent = await provider.exists(testFilename);
    if (!existsPresent) throw new Error("exists() returned false for an uploaded file.");

    const existsMissing = await provider.exists(`missing-file-${Date.now()}.bin`);
    if (existsMissing) throw new Error("exists() returned true for a nonexistent file.");
  });

  // 8. Error Mapping on Missing Object
  await test("Storage: download() on missing file throws OBJECT_NOT_FOUND StorageError", async () => {
    try {
      await provider.download(`nonexistent-${Date.now()}.txt`);
      throw new Error("download() did not throw on missing file.");
    } catch (err) {
      if (!StorageError.isStorageError(err) || err.code !== BYOCErrorCode.OBJECT_NOT_FOUND) {
        throw new Error(`Expected StorageError with code OBJECT_NOT_FOUND, received: ${err}`);
      }
    }
  });

  // 9. Deletion & Post-Deletion Check
  await test("Storage: delete() removes the file cleanly", async () => {
    await provider.delete(testFilename);
    const exists = await provider.exists(testFilename);
    if (exists) throw new Error("exists() returned true after delete().");
  });

  // 10. Folder Operations (if supported)
  if (capabilities.folders && !options.skipFolders && provider.createFolder) {
    const folderPath = `test-dir-${Date.now()}`;
    await test("Folders: createFolder() creates a folder node", async () => {
      const folder = await provider.createFolder!(folderPath);
      if (folder.type !== "folder") throw new Error("createFolder() must return type 'folder'.");
    });
  }

  // 11. Quota Operations (if supported)
  if (capabilities.quota && !options.skipQuota && provider.quota) {
    await test("Quota: quota() returns total and used metrics", async () => {
      const q = await provider.quota!();
      if (q.used < 0) throw new Error("Quota 'used' must be non-negative.");
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    providerId: manifest.id,
    providerName: manifest.name,
    total: results.length,
    passed,
    failed,
    results
  };
}
