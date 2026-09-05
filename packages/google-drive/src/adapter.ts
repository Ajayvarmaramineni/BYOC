import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest,
  StorageInput,
  StorageObject,
  StorageOutput,
  StorageQuota,
  UploadOptions,
  BackupOptions,
  UploadGrant,
  UploadGrantOptions
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
      adapterVersion: "0.3.0"
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
      serverSideCopy: true,
      directUpload: true
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

    // A stream has no length to compare against a threshold, and chunked
    // transfer is the only way to send one, so it always goes resumable.
    const isStream =
      byteLength === undefined &&
      typeof data !== "string" &&
      typeof (data as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] === "function";

    let resource;
    if (isStream) {
      resource = await this.uploader.uploadStream(
        metadata,
        data as AsyncIterable<Uint8Array>,
        options?.mimeType ?? "application/octet-stream",
        options?.chunkSize,
        options?.onProgress
      );
    } else if (shouldUseResumable) {
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
  /**
   * Opens a resumable session and hands back its URI as an upload grant.
   *
   * Unlike S3's signed URL, this is not a signature over a path -- Drive has
   * already created the pending file, and the session URI is the only way to
   * write to it. Two consequences worth knowing:
   *
   *  - `sizeBytes` is required. Drive wants X-Upload-Content-Length up front,
   *    and a session opened with the wrong total rejects the final chunk.
   *  - Sessions last about a week, far longer than a signed URL, so this
   *    still honours `expiresInSeconds` and reports the earlier of the two.
   */
  public async createUploadGrant(
    path: string,
    options: UploadGrantOptions = {}
  ): Promise<UploadGrant> {
    const normalized = normalizeVirtualPath(path);
    if (options.sizeBytes === undefined) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message:
          "Google Drive needs the total size before opening a resumable session. " +
          "Pass sizeBytes (file.size in the browser) when creating the grant.",
        provider: "google-drive",
        retryable: false
      });
    }

    const parentFolderId = await this.resolver.resolveParentFolderId(normalized);
    const mimeType = options.mimeType ?? "application/octet-stream";

    const sessionUri = await this.uploader.createSession(
      {
        name: getBasename(normalized),
        parents: [parentFolderId],
        mimeType,
        appProperties: { byocVirtualPath: normalized }
      },
      options.sizeBytes,
      mimeType
    );

    const expiresInSeconds = options.expiresInSeconds ?? 900;
    return {
      provider: "google-drive",
      path: normalized,
      url: sessionUri,
      method: "PUT",
      headers: {},
      protocol: "resumable",
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      // Drive requires every chunk but the last to be a multiple of 256 KiB.
      chunkSize: 8 * 1024 * 1024,
      maxBytes: options.sizeBytes
    };
  }

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
