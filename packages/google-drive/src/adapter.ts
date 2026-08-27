import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest,
  StorageInput,
  StorageObject,
  StorageOutput,
  StorageQuota,
  UploadOptions,
  BackupOptions
} from "@byoc/core";
import {
  BYOCErrorCode,
  StorageError,
  normalizeVirtualPath,
  getBasename
} from "@byoc/core";
import type { GoogleDriveProviderConfig } from "./auth/types.js";
import { GoogleOAuthClient } from "./auth/oauth-client.js";
import { DriveHttpClient } from "./api/http.js";
import {
  GoogleDrivePathResolver,
  LruTtlPathCache,
  type PathCache
} from "./paths/virtual-path.js";

import { ResumableUploader } from "./api/resumable.js";
import { buildMultipartBody } from "./api/multipart.js";

/**
 * GoogleDriveProvider — Official reference adapter for Google Drive.
 */
export class GoogleDriveProvider implements BYOCProvider {
  public readonly config: GoogleDriveProviderConfig;
  public readonly oauth: GoogleOAuthClient;
  public readonly http: DriveHttpClient;
  public readonly uploader: ResumableUploader;
  public readonly resolver: GoogleDrivePathResolver;

  constructor(
    config: GoogleDriveProviderConfig,
    options?: { pathCache?: PathCache }
  ) {
    if (!config || !config.auth || !config.auth.clientId) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "GoogleDriveProvider requires a valid 'auth.clientId'.",
        provider: "google-drive",
        retryable: false
      });
    }

    this.config = {
      ...config,
      rootFolderName: config.rootFolderName ?? "BYOC"
    };

    this.oauth = new GoogleOAuthClient(config.auth);
    this.http = new DriveHttpClient(this.oauth);
    this.uploader = new ResumableUploader(this.oauth);
    const cache = options?.pathCache ?? new LruTtlPathCache();
    this.resolver = new GoogleDrivePathResolver(this.http, this.config.rootFolderName, cache);
  }

  /**
   * Manifest identifying this provider to the BYOC runtime.
   */
  public manifest(): ProviderManifest {
    return {
      id: "google-drive",
      name: "Google Drive",
      category: "personal-cloud",
      authentication: "oauth2",
      supportsUserOwnedStorage: true,
      adapterVersion: "0.2.0"
    };
  }

  /**
   * Declares the capabilities supported by Google Drive.
   */
  public capabilities(): ProviderCapabilities {
    return {
      folders: true,
      sharing: true,
      publicUrls: false,
      resumableUploads: true,
      versioning: false,
      quota: true,
      serverSideCopy: true
    };
  }

  /**
   * Initialize and verify OAuth connection session, ensuring the root app folder exists.
   */
  public async connect(): Promise<void> {
    const hasSession = await this.oauth.hasValidSession();
    if (!hasSession) {
      throw new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "Google Drive authentication required: No valid session found. Please complete OAuth flow.",
        provider: "google-drive",
        statusCode: 401,
        retryable: false
      });
    }

    // Verify token validity by resolving root folder
    await this.resolver.ensureRootFolder();
  }

  /**
   * Disconnect and clear local token/cache sessions, revoking active credentials.
   */
  public async disconnect(): Promise<void> {
    await this.oauth.revoke();
    await this.resolver.clearCache();
  }

  /**
   * Uploads a file to Google Drive (using multipart for small files, resumable for large files).
   */
  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    const filename = getBasename(normalized);
    const parentFolderId = await this.resolver.resolveParentFolderId(normalized);

    const metadata = {
      name: filename,
      parents: [parentFolderId],
      mimeType: options?.mimeType,
      appProperties: {
        byocVirtualPath: normalized,
        ...((options?.metadata as Record<string, string>) || {})
      }
    };

    // Determine if resumable upload is appropriate (explicit flag, onProgress listener, or large byte length)
    const byteLength =
      typeof data === "string"
        ? Buffer.byteLength(data)
        : data instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(data))
          ? data.byteLength
          : undefined;

    const isLarge = byteLength !== undefined && byteLength >= 5 * 1024 * 1024; // 5 MB threshold
    const shouldUseResumable = options?.resumable || options?.onProgress || isLarge;

    let resource;
    if (shouldUseResumable) {
      resource = await this.uploader.upload(metadata, data, {
        mimeType: options?.mimeType,
        chunkSize: options?.chunkSize,
        onProgress: options?.onProgress
      });
    } else {
      const multipart = await buildMultipartBody(metadata, data, options?.mimeType);
      const boundaryMatch = multipart.contentType.match(/boundary=(.+)$/);
      const boundary = boundaryMatch ? boundaryMatch[1]! : `BYOC_${Date.now()}`;
      resource = await this.http.uploadMultipart(boundary, multipart.body);
    }

    // Cache the resolved file ID
    await this.resolver.setCached(normalized, resource.id);

    return this.http.toStorageObject(resource, normalized);
  }

  /**
   * Downloads a file from Google Drive with 404 cache self-healing.
   */
  public async download(path: string): Promise<StorageOutput> {
    const normalized = normalizeVirtualPath(path);

    try {
      const fileId = await this.resolver.resolveFileId(normalized);
      const resource = await this.http.getFile(fileId);
      const media = await this.http.downloadMedia(fileId);

      return {
        stream: media.stream,
        arrayBuffer: media.arrayBuffer,
        text: media.text,
        metadata: this.http.toStorageObject(resource, normalized)
      };
    } catch (err) {
      // If 404 occurs on cached ID, invalidate cache and retry once
      if (StorageError.isStorageError(err) && err.code === BYOCErrorCode.OBJECT_NOT_FOUND) {
        await this.resolver.invalidate(normalized);
        const freshFileId = await this.resolver.resolveFileId(normalized, { skipCache: true });
        const resource = await this.http.getFile(freshFileId);
        const media = await this.http.downloadMedia(freshFileId);

        return {
          stream: media.stream,
          arrayBuffer: media.arrayBuffer,
          text: media.text,
          metadata: this.http.toStorageObject(resource, normalized)
        };
      }
      throw err;
    }
  }

  /**
   * Deletes an object from Google Drive with cache invalidation.
   * If softDelete option is specified, moves the file to Google Drive Trash.
   */
  public async delete(path: string, options?: { softDelete?: boolean }): Promise<void> {
    const normalized = normalizeVirtualPath(path);
    const fileId = await this.resolver.resolveFileId(normalized);
    if (options?.softDelete) {
      await this.http.trashFile(fileId);
    } else {
      await this.http.deleteFile(fileId);
    }
    await this.resolver.invalidate(normalized);
  }

  /**
   * Server-side instant copy in Google Drive using files.copy without re-uploading bytes.
   */
  public async copy(source: string, destination: string): Promise<void> {
    const sourceNorm = normalizeVirtualPath(source);
    const destNorm = normalizeVirtualPath(destination);

    const sourceFileId = await this.resolver.resolveFileId(sourceNorm);
    const destParentId = await this.resolver.resolveParentFolderId(destNorm);
    const newFilename = getBasename(destNorm);

    const copied = await this.http.copyFile(sourceFileId, newFilename, destParentId);
    await this.resolver.setCached(destNorm, copied.id);
  }

  /**
   * Server-side instant move in Google Drive using files.update (parent swapping) without re-uploading bytes.
   */
  public async move(source: string, destination: string): Promise<void> {
    const sourceNorm = normalizeVirtualPath(source);
    const destNorm = normalizeVirtualPath(destination);

    const sourceFileId = await this.resolver.resolveFileId(sourceNorm);
    const oldParentId = await this.resolver.resolveParentFolderId(sourceNorm);
    const newParentId = await this.resolver.resolveParentFolderId(destNorm);
    const newFilename = getBasename(destNorm);

    await this.http.moveFile(sourceFileId, newParentId, oldParentId, newFilename);
    await this.resolver.invalidate(sourceNorm);
    await this.resolver.setCached(destNorm, sourceFileId);
  }

  /**
   * Lists files and folders within a path.
   */
  public async list(path?: string): Promise<StorageObject[]> {
    const normalized = normalizeVirtualPath(path);
    const parentId = normalized
      ? await this.resolver.resolveFileId(normalized)
      : await this.resolver.ensureRootFolder();

    const query = `'${parentId}' in parents and trashed = false`;
    const response = await this.http.listFiles(query);

    return response.files.map((file) => {
      const childPath = normalized ? `${normalized}/${file.name}` : file.name;
      return this.http.toStorageObject(file, childPath);
    });
  }

  /**
   * Checks if an object exists in Google Drive.
   */
  public async exists(path: string): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) return true;

    try {
      await this.resolver.resolveFileId(normalized);
      return true;
    } catch (err) {
      if (StorageError.isStorageError(err) && err.code === BYOCErrorCode.OBJECT_NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Retrieves metadata for an object in Google Drive.
   */
  public async metadata(path: string): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    const fileId = await this.resolver.resolveFileId(normalized);
    const resource = await this.http.getFile(fileId);
    return this.http.toStorageObject(resource, normalized);
  }

  /**
   * Creates a virtual folder in Google Drive.
   */
  public async createFolder(path: string): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    const folderId = await this.resolver.resolveOrCreateFolderPath(normalized);
    const resource = await this.http.getFile(folderId);
    return this.http.toStorageObject(resource, normalized);
  }

  /**
   * Retrieves user storage quota from Google Drive.
   */
  public async quota(): Promise<StorageQuota> {
    const about = await this.http.getAboutQuota();
    const quotaData = about.storageQuota;

    return {
      total: quotaData?.limit ? Number(quotaData.limit) : undefined,
      used: quotaData?.usage ? Number(quotaData.usage) : 0,
      available:
        quotaData?.limit && quotaData.usage
          ? Math.max(0, Number(quotaData.limit) - Number(quotaData.usage))
          : undefined
    };
  }

  /**
   * Specialized backup helper.
   */
  public async backup(
    payload: StorageInput,
    options?: BackupOptions
  ): Promise<StorageObject> {
    const folder = normalizeVirtualPath(options?.folder ?? "Backups");
    const filename =
      options?.filename ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const targetPath = folder ? `${folder}/${filename}` : filename;

    return this.upload(targetPath, payload, {
      mimeType: options?.mimeType ?? "application/json",
      onProgress: options?.onProgress
    });
  }
}
