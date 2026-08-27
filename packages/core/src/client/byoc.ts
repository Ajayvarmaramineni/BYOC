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
  BackupOptions
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
