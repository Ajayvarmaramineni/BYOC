import type {
  StorageObject,
  StorageInput,
  StorageOutput,
  UploadOptions,
  BackupOptions,
  StorageQuota,
  UploadGrant,
  UploadGrantOptions
} from "./storage.js";

export type ProviderCategory = "personal-cloud" | "self-hosted" | "developer-cloud";
export type AuthType = "oauth2" | "access-key" | "basic" | "local";

/**
 * Manifest describing provider metadata and identification.
 */
export interface ProviderManifest {
  readonly id: string;
  readonly name: string;
  readonly category: ProviderCategory;
  readonly authentication: AuthType;
  readonly supportsUserOwnedStorage: boolean;
  readonly adapterVersion: string;
}

/**
 * Explicit capabilities supported by a given provider.
 * Allows client applications to feature-detect without guessing.
 */
export interface ProviderCapabilities {
  readonly folders: boolean;
  readonly sharing: boolean;
  readonly publicUrls: boolean;
  readonly resumableUploads: boolean;
  readonly versioning: boolean;
  readonly quota: boolean;
  readonly serverSideCopy: boolean;
  /**
   * Whether the provider can mint an {@link UploadGrant}, letting a browser
   * upload straight to the user's cloud without the bytes crossing this server.
   */
  readonly directUpload: boolean;
}

/**
 * Universal interface that every BYOC storage adapter must implement.
 */
export interface BYOCProvider {
  /** Returns the static or dynamic manifest for this provider */
  manifest(): ProviderManifest;

  /** Returns the capabilities supported by this provider instance */
  capabilities(): Promise<ProviderCapabilities> | ProviderCapabilities;

  /** Establish or verify connection / session to the storage backend */
  connect(): Promise<void>;

  /** Disconnect and revoke/clear active session tokens */
  disconnect(): Promise<void>;

  /**
   * Upload binary data to the target virtual path.
   * @param path Virtual path (e.g. "reports/q3.pdf")
   * @param data Binary payload (Buffer, Stream, Uint8Array, Blob, string)
   * @param options Upload options (resumable, mimeType, onProgress)
   */
  upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject>;

  /**
   * Download binary data from the specified virtual path.
   * @param path Virtual path
   */
  download(path: string): Promise<StorageOutput>;

  /**
   * Delete an object at the specified virtual path.
   * @param path Virtual path
   */
  delete(path: string): Promise<void>;

  /**
   * List objects within an optional virtual folder path.
   * @param path Virtual folder path (empty or omitted for root)
   */
  list(path?: string): Promise<StorageObject[]>;

  /**
   * Check if an object exists at the specified virtual path.
   * @param path Virtual path
   */
  exists(path: string): Promise<boolean>;

  /**
   * Retrieve metadata for the object at the virtual path.
   * @param path Virtual path
   */
  metadata(path: string): Promise<StorageObject>;

  // Optional Capability-Dependent Operations
  createFolder?(path: string): Promise<StorageObject>;
  move?(source: string, destination: string): Promise<void>;
  copy?(source: string, destination: string): Promise<void>;
  quota?(): Promise<StorageQuota>;
  createUploadGrant?(path: string, options?: UploadGrantOptions): Promise<UploadGrant>;
  backup?(payload: StorageInput, options?: BackupOptions): Promise<StorageObject>;
}
