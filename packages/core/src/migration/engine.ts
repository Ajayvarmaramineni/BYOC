import type { BYOCProvider } from "../types/provider.js";
import { BYOCErrorCode } from "../errors/codes.js";
import { StorageError } from "../errors/storage-error.js";
import { normalizeVirtualPath } from "../paths/resolver.js";

export type ConflictStrategy = "overwrite" | "skip" | "error";

export interface MigrationProgress {
  currentFile: string;
  filesMigrated: number;
  filesTotal: number;
  bytesTransferred: number;
  percentage: number;
}

export interface MigrationOptions {
  /** Source storage provider instance */
  source: BYOCProvider;
  /** Destination target storage provider instance */
  target: BYOCProvider;
  /** Explicit array of file paths to migrate */
  paths: string[];
  /** Conflict resolution strategy if file already exists on target (default: "overwrite") */
  conflictStrategy?: ConflictStrategy;
  /** Concurrency limit for parallel file migration (default: 4) */
  concurrency?: number;
  /** Delete file from source provider after successful target upload (default: false) */
  deleteSourceAfterMigrate?: boolean;
  /** Granular progress reporting callback */
  onProgress?: (progress: MigrationProgress) => void;
}

export interface MigrationFileResult {
  path: string;
  /**
   * `partial` means the copy to the target succeeded but the optional source
   * deletion did not — the data exists on the target, and the source copy is
   * still present. Callers retrying `failed` paths should not retry `partial`
   * ones: the transfer is done, only the source cleanup remains.
   */
  status: "migrated" | "skipped" | "failed" | "partial";
  size?: number;
  error?: string;
}

export interface MigrationReport {
  sourceProvider: string;
  targetProvider: string;
  filesTotal: number;
  filesMigrated: number;
  filesSkipped: number;
  filesFailed: number;
  /** Copied to the target, but the optional source deletion failed. */
  filesPartial: number;
  bytesTransferred: number;
  results: MigrationFileResult[];
}

/**
 * Universal Migration Engine for zero-downtime, stream-piped data transfer between clouds.
 */
export class MigrationEngine {
  /**
   * Migrates files from source provider to target provider with stream piping and concurrency control.
   */
  public static async migrate(options: MigrationOptions): Promise<MigrationReport> {
    const {
      source,
      target,
      paths,
      conflictStrategy = "overwrite",
      concurrency = 4,
      deleteSourceAfterMigrate = false,
      onProgress
    } = options;

    if (!source || !target) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Migration requires both 'source' and 'target' provider adapters.",
        provider: "migration-engine"
      });
    }

    if (!paths || paths.length === 0) {
      return {
        sourceProvider: source.manifest().id,
        targetProvider: target.manifest().id,
        filesTotal: 0,
        filesMigrated: 0,
        filesSkipped: 0,
        filesFailed: 0,
        filesPartial: 0,
        bytesTransferred: 0,
        results: []
      };
    }

    const cleanPaths = paths.map((p) => normalizeVirtualPath(p)).filter(Boolean);
    const results: MigrationFileResult[] = [];
    let bytesTransferred = 0;
    let filesMigrated = 0;
    let filesSkipped = 0;
    let filesFailed = 0;
    let filesPartial = 0;

    let currentIndex = 0;
    const safeConcurrency = Math.max(1, Math.floor(concurrency || 4));

    const emitProgress = (currentFile: string) => {
      if (onProgress) {
        const finishedCount = filesMigrated + filesSkipped + filesFailed + filesPartial;
        onProgress({
          currentFile,
          filesMigrated,
          filesTotal: cleanPaths.length,
          bytesTransferred,
          percentage: cleanPaths.length > 0 ? Math.round((finishedCount / cleanPaths.length) * 100) : 100
        });
      }
    };

    // Worker pool for bounded concurrency
    const worker = async () => {
      while (currentIndex < cleanPaths.length) {
        const index = currentIndex++;
        const filePath = cleanPaths[index]!;

        try {
          // 1. Check if target already has file
          if (conflictStrategy !== "overwrite") {
            const existsOnTarget = await target.exists(filePath);
            if (existsOnTarget) {
              if (conflictStrategy === "skip") {
                filesSkipped++;
                results.push({ path: filePath, status: "skipped" });
                emitProgress(filePath);
                continue;
              }
              if (conflictStrategy === "error") {
                throw new StorageError({
                  code: BYOCErrorCode.OBJECT_ALREADY_EXISTS,
                  message: `File already exists on target provider at path: "${filePath}"`,
                  provider: target.manifest().id
                });
              }
            }
          }

          // 2. Download from source
          const sourceOutput = await source.download(filePath);
          const mimeType = sourceOutput.metadata.mimeType;
          const fileSize = sourceOutput.metadata.size ?? 0;

          // 3. Direct streaming pipe to target (zero-RAM buffering)
          const payload = sourceOutput.stream ?? (await sourceOutput.arrayBuffer());

          await target.upload(filePath, payload, { mimeType });

          // 4. The bytes are now on the target. Any failure past this point is a
          //    cleanup failure, not a transfer failure, so it must not be reported
          //    as `failed` — callers retry failures, and re-copying is wasted work.
          if (deleteSourceAfterMigrate) {
            try {
              await source.delete(filePath);
            } catch (deleteErr: unknown) {
              bytesTransferred += fileSize;
              filesPartial++;
              results.push({
                path: filePath,
                status: "partial",
                size: fileSize,
                error: `Copied to target, but source deletion failed: ${
                  deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
                }`
              });
              emitProgress(filePath);
              continue;
            }
          }

          // 5. Record successful migration only after all operations succeed
          bytesTransferred += fileSize;
          filesMigrated++;
          results.push({ path: filePath, status: "migrated", size: fileSize });

          emitProgress(filePath);
        } catch (err: unknown) {
          filesFailed++;
          const errorMessage = err instanceof Error ? err.message : String(err);
          results.push({ path: filePath, status: "failed", error: errorMessage });
          emitProgress(filePath);
        }
      }
    };

    const workers = Array.from({ length: Math.min(safeConcurrency, cleanPaths.length) }, () => worker());
    await Promise.all(workers);

    return {
      sourceProvider: source.manifest().id,
      targetProvider: target.manifest().id,
      filesTotal: cleanPaths.length,
      filesMigrated,
      filesSkipped,
      filesFailed,
      filesPartial,
      bytesTransferred,
      results
    };
  }
}
