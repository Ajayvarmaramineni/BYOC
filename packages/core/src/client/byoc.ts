import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest
} from "../types/provider.js";
import type {
  StorageInput,
  StorageObject,
  StorageOutput,
  StorageQuota,
  UploadOptions,
  BackupOptions,
  BatchDeleteReport,
  BatchFailure,
  SignedUrlOptions,
  UploadGrant,
  UploadGrantOptions
} from "../types/storage.js";
import { normalizeVirtualPath } from "../paths/resolver.js";
import { BYOCErrorCode } from "../errors/codes.js";
import { StorageError } from "../errors/storage-error.js";
import { type BYOCLogger, SafeLogger, SilentLogger } from "../utils/logger.js";
import { lookupMimeType } from "../utils/mime.js";
import {
  MigrationEngine,
  type ConflictStrategy,
  type MigrationProgress,
  type MigrationReport
} from "../migration/engine.js";

export interface BYOCConfig {
  /** Single default storage provider */
  provider?: BYOCProvider;
  /** Array of supported storage providers for multi-provider routing */
  providers?: BYOCProvider[];
  /** Optional initial provider ID to activate if multiple providers are configured */
  defaultProviderId?: string;
  /** Optional custom logger instance or "silent" to disable logging */
  logger?: BYOCLogger | "silent";
  /** Optional maximum allowed file size in bytes */
  maxFileSizeBytes?: number;
}

/**
 * BYOC — Universal Client for User-Owned, Self-Hosted, and Multi-Cloud Storage.
 */
export class BYOC {
  private readonly providerRegistry = new Map<string, BYOCProvider>();
  private readonly logger: BYOCLogger;
  private readonly maxFileSizeBytes?: number;
  private currentProvider: BYOCProvider;

  constructor(config: BYOCConfig) {
    if (!config) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "BYOC initialization failed: Configuration options must be supplied.",
        provider: "core",
        retryable: false
      });
    }

    this.logger =
      config.logger === "silent"
        ? new SilentLogger()
        : config.logger ?? new SafeLogger("info");
    this.maxFileSizeBytes = config.maxFileSizeBytes;

    const providerList: BYOCProvider[] = [];

    if (config.provider) {
      providerList.push(config.provider);
    }
    if (config.providers && Array.isArray(config.providers)) {
      providerList.push(...config.providers);
    }

    if (providerList.length === 0) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "BYOC initialization failed: At least one 'provider' adapter must be supplied.",
        provider: "core",
        retryable: false
      });
    }

    // Register all providers by their manifest ID
    for (const provider of providerList) {
      const manifest = provider.manifest();
      this.providerRegistry.set(manifest.id, provider);
    }

    // Select initial active provider
    if (config.defaultProviderId && this.providerRegistry.has(config.defaultProviderId)) {
      this.currentProvider = this.providerRegistry.get(config.defaultProviderId)!;
    } else {
      this.currentProvider = providerList[0]!;
    }
  }

  /**
   * Switches the active storage provider by its manifest ID (e.g. "google-drive", "onedrive", "cloudflare-r2").
   */
  public useProvider(providerId: string): this {
    const target = this.providerRegistry.get(providerId);
    if (!target) {
      const available = Array.from(this.providerRegistry.keys()).join(", ");
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `Provider '${providerId}' is not registered in this BYOC client. Available providers: [${available}]`,
        provider: "core",
        retryable: false
      });
    }
    this.currentProvider = target;
    return this;
  }

  /**
   * Returns a list of manifests for all registered storage providers.
   */
  public getProviders(): ProviderManifest[] {
    return Array.from(this.providerRegistry.values()).map((p) => p.manifest());
  }

  /**
   * Returns the metadata manifest of the active provider.
   */
  public manifest(): ProviderManifest {
    return this.currentProvider.manifest();
  }

  /**
   * Returns the feature capabilities supported by the active provider.
   */
  public async capabilities(): Promise<ProviderCapabilities> {
    return this.currentProvider.capabilities();
  }

  /**
   * Checks whether the active provider supports a specific capability.
   */
  public async hasCapability(capability: keyof ProviderCapabilities): Promise<boolean> {
    const caps = await this.capabilities();
    return !!caps[capability];
  }

  /**
   * Returns the active safe logger instance.
   */
  public getLogger(): BYOCLogger {
    return this.logger;
  }

  /**
   * Authenticate and initialize the connection with the active storage provider.
   */
  public async connect(): Promise<void> {
    this.logger.debug(`Connecting to provider: ${this.manifest().id}`);
    return this.currentProvider.connect();
  }

  /**
   * Disconnect and clear/revoke authentication tokens for the active provider.
   */
  public async disconnect(): Promise<void> {
    this.logger.debug(`Disconnecting from provider: ${this.manifest().id}`);
    return this.currentProvider.disconnect();
  }

  /**
   * Upload binary data to the target virtual path.
   */
  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Upload requires a valid non-empty file path.",
        provider: this.manifest().id,
        retryable: false
      });
    }

    // Validate size limit if payload is in-memory
    if (this.maxFileSizeBytes !== undefined) {
      const size =
        typeof data === "string"
          ? Buffer.byteLength(data)
          : data instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(data))
            ? data.byteLength
            : undefined;

      if (size !== undefined && size > this.maxFileSizeBytes) {
        throw new StorageError({
          code: BYOCErrorCode.INVALID_INPUT,
          message: `File size (${size} bytes) exceeds configured maximum limit of ${this.maxFileSizeBytes} bytes.`,
          provider: this.manifest().id,
          retryable: false
        });
      }
    }

    // Auto-detect MIME type if omitted
    const effectiveMimeType = options?.mimeType || lookupMimeType(normalized);

    this.logger.debug(`Uploading to ${normalized} (${effectiveMimeType}) on ${this.manifest().id}`);

    return this.currentProvider.upload(normalized, data, {
      ...options,
      mimeType: effectiveMimeType
    });
  }

  /**
   * Convenience helper to upload a UTF-8 text string directly.
   */
  public async writeText(
    path: string,
    content: string,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    const mime = options?.mimeType || lookupMimeType(normalized, "text/plain; charset=utf-8");
    return this.upload(path, content, {
      ...options,
      mimeType: mime
    });
  }

  /**
   * Convenience helper to upload a binary buffer directly.
   */
  public async writeBuffer(
    path: string,
    buffer: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    return this.upload(path, buffer, options);
  }

  /**
   * Download binary data and metadata from the specified virtual path.
   */
  public async download(path: string): Promise<StorageOutput> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Download requires a valid non-empty file path.",
        provider: this.manifest().id,
        retryable: false
      });
    }
    return this.currentProvider.download(normalized);
  }

  /**
   * Convenience helper to download and decode a file directly as a UTF-8 string.
   */
  public async readText(path: string): Promise<string> {
    const output = await this.download(path);
    return output.text();
  }

  /**
   * Convenience helper to download and return a file directly as an ArrayBuffer.
   */
  public async readBuffer(path: string): Promise<ArrayBuffer> {
    const output = await this.download(path);
    return output.arrayBuffer();
  }

  /**
   * Delete the object at the specified virtual path.
   */
  public async delete(path: string): Promise<void> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Delete requires a valid non-empty file path.",
        provider: this.manifest().id,
        retryable: false
      });
    }
    return this.currentProvider.delete(normalized);
  }

  /**
   * List files and folders within an optional folder path.
   */
  public async list(path?: string): Promise<StorageObject[]> {
    const normalized = normalizeVirtualPath(path);
    return this.currentProvider.list(normalized);
  }

  /**
   * Check whether an object exists at the specified virtual path.
   */
  public async exists(path: string): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) return false;
    return this.currentProvider.exists(normalized);
  }

  /**
   * Get metadata for an object at the specified virtual path.
   */
  public async metadata(path: string): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Metadata check requires a valid non-empty file path.",
        provider: this.manifest().id,
        retryable: false
      });
    }
    return this.currentProvider.metadata(normalized);
  }

  /**
   * Create a virtual folder if supported by the provider.
   */
  public async createFolder(path: string): Promise<StorageObject> {
    const capabilities = await this.capabilities();
    if (!capabilities.folders || !this.currentProvider.createFolder) {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message: `Provider '${this.manifest().name}' does not support explicit folder creation.`,
        provider: this.manifest().id,
        retryable: false
      });
    }
    const normalized = normalizeVirtualPath(path);
    return this.currentProvider.createFolder(normalized);
  }

  /**
   * Move an object from source to destination virtual path.
   */
  /**
   * Copies an object. Every current adapter performs this server-side, so the
   * bytes never travel through this process.
   */
  public async copy(source: string, destination: string): Promise<void> {
    if (!this.currentProvider.copy) {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message: `Provider '${this.manifest().name}' does not support native copy operations.`,
        provider: this.manifest().id,
        retryable: false
      });
    }
    const normSource = normalizeVirtualPath(source);
    const normDest = normalizeVirtualPath(destination);
    return this.currentProvider.copy(normSource, normDest);
  }

  public async move(source: string, destination: string): Promise<void> {
    if (!this.currentProvider.move) {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message: `Provider '${this.manifest().name}' does not support native move operations.`,
        provider: this.manifest().id,
        retryable: false
      });
    }
    const normSource = normalizeVirtualPath(source);
    const normDest = normalizeVirtualPath(destination);
    return this.currentProvider.move(normSource, normDest);
  }

  /**
   * Retrieve current storage quota usage.
   */
  public async getQuota(): Promise<StorageQuota> {
    const capabilities = await this.capabilities();
    if (!capabilities.quota || !this.currentProvider.quota) {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message: `Provider '${this.manifest().name}' does not support quota reporting.`,
        provider: this.manifest().id,
        retryable: false
      });
    }
    return this.currentProvider.quota();
  }

  /**
   * A time-limited URL a browser can use directly, without proxying bytes.
   *
   * Only providers reporting `publicUrls` can issue one. Google Drive and
   * WebDAV cannot, so they throw rather than returning a URL that would need
   * the caller's credentials to be useful.
   */
  public async getSignedUrl(path: string, options?: SignedUrlOptions): Promise<string> {
    const capabilities = await this.capabilities();
    const signer = (this.currentProvider as { getSignedUrl?: unknown }).getSignedUrl;

    if (!capabilities.publicUrls || typeof signer !== "function") {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message: `Provider '${this.manifest().name}' cannot issue signed URLs.`,
        provider: this.manifest().id,
        retryable: false
      });
    }

    return (signer as (p: string, o?: SignedUrlOptions) => string).call(
      this.currentProvider,
      normalizeVirtualPath(path),
      options
    );
  }

  /**
   * Yields every object beneath `path`, descending into folders.
   *
   * `list` returns one level, which is right for rendering a file browser and
   * wrong for "everything under here". This walks the tree breadth-first,
   * yielding folders before their contents.
   *
   * It is built on `list`, so it costs one call per folder.
   */
  public async *walk(path?: string): AsyncGenerator<StorageObject> {
    const pending: (string | undefined)[] = [normalizeVirtualPath(path ?? "") || undefined];

    while (pending.length > 0) {
      const current = pending.shift();
      for (const item of await this.currentProvider.list(current)) {
        yield item;
        if (item.type === "folder") pending.push(item.path);
      }
    }
  }

  /**
   * Deletes everything under `path`, then `path` itself.
   *
   * Children are deleted before their parents, so a provider that refuses to
   * remove a non-empty folder still ends up with an empty one to remove.
   * Failures are collected rather than aborting the walk.
   */
  public async deleteTree(path: string): Promise<BatchDeleteReport> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Delete tree requires a valid non-empty path.",
        provider: this.manifest().id,
        retryable: false
      });
    }

    const descendants: StorageObject[] = [];
    for await (const item of this.walk(normalized)) descendants.push(item);

    // Deepest first: a folder must be emptied before it can be removed.
    descendants.sort(
      (a, b) => b.path.split("/").length - a.path.split("/").length
    );

    return this.deleteMany([...descendants.map((item) => item.path), normalized], 1);
  }

  /**
   * Deletes several paths, reporting per-path outcomes.
   *
   * One failure does not abort the rest: a locked or already-removed object is
   * the common case, and the caller needs to know which paths survived rather
   * than losing the whole batch.
   */
  public async deleteMany(paths: string[], concurrency = 8): Promise<BatchDeleteReport> {
    if (concurrency < 1) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "deleteMany concurrency must be at least 1.",
        provider: this.manifest().id,
        retryable: false
      });
    }

    const deleted: string[] = [];
    const failed: BatchFailure[] = [];
    const queue = [...paths];

    const worker = async (): Promise<void> => {
      for (;;) {
        const target = queue.shift();
        if (target === undefined) return;
        try {
          await this.delete(target);
          deleted.push(target);
        } catch (error) {
          failed.push({
            path: target,
            error: (error as Error).message,
            code: (error as StorageError).code ?? BYOCErrorCode.PROVIDER_UNAVAILABLE
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker)
    );

    return {
      deleted,
      failed,
      total: deleted.length + failed.length,
      allSucceeded: failed.length === 0
    };
  }

  /**
   * Mints a capability the browser uses to upload straight to the user's cloud.
   *
   * This is the operation the whole project exists for: the bytes go from the
   * user's machine to the user's own storage, and this server sees a path and
   * a size but never any content. Return the grant from an API route and hand
   * it to `uploadWithGrant` from `@byoc/browser`.
   *
   * The grant is a bearer capability. Anyone holding it can write to that one
   * path until it expires, so keep the lifetime short and only issue one after
   * checking the caller is allowed to write there.
   */
  public async createUploadGrant(
    path: string,
    options?: UploadGrantOptions
  ): Promise<UploadGrant> {
    const capabilities = await this.capabilities();
    if (!capabilities.directUpload || !this.currentProvider.createUploadGrant) {
      throw new StorageError({
        code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
        message:
          `Provider '${this.manifest().name}' cannot issue upload grants, so a ` +
          "browser cannot upload to it directly. Upload through this server instead.",
        provider: this.manifest().id,
        retryable: false
      });
    }

    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Creating an upload grant requires a valid non-empty file path.",
        provider: this.manifest().id,
        retryable: false
      });
    }

    return this.currentProvider.createUploadGrant(normalized, options);
  }

  /**
   * High-level backup helper to export data to the user's storage.
   */
  public async backup(
    payload: StorageInput,
    options?: BackupOptions
  ): Promise<StorageObject> {
    if (this.currentProvider.backup) {
      return this.currentProvider.backup(payload, options);
    }

    const folder = normalizeVirtualPath(options?.folder ?? "Backups");
    const filename =
      options?.filename ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const targetPath = folder ? `${folder}/${filename}` : filename;

    return this.upload(targetPath, payload, {
      mimeType: options?.mimeType,
      onProgress: options?.onProgress
    });
  }

  /**
   * Migrates files between any two registered storage providers with zero-copy stream piping.
   */
  public async migrate(options: {
    from: string;
    to: string;
    paths: string[];
    conflictStrategy?: ConflictStrategy;
    deleteSourceAfterMigrate?: boolean;
    onProgress?: (progress: MigrationProgress) => void;
  }): Promise<MigrationReport> {
    const source = this.providerRegistry.get(options.from);
    const target = this.providerRegistry.get(options.to);

    if (!source) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `Source provider '${options.from}' is not registered in this BYOC client.`,
        provider: "core"
      });
    }

    if (!target) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `Destination provider '${options.to}' is not registered in this BYOC client.`,
        provider: "core"
      });
    }

    this.logger.info(`Starting cloud migration from ${options.from} to ${options.to} (${options.paths.length} files)`);

    return MigrationEngine.migrate({
      source,
      target,
      paths: options.paths,
      conflictStrategy: options.conflictStrategy,
      deleteSourceAfterMigrate: options.deleteSourceAfterMigrate,
      onProgress: options.onProgress
    });
  }
}
