import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest,
  StorageInput,
  StorageObject,
  StorageOutput,
  UploadOptions,
  BackupOptions,
  UploadGrant,
  UploadGrantOptions
} from "@byoc/core";
import {
  BYOCErrorCode,
  StorageError,
  normalizeVirtualPath
} from "@byoc/core";
import { S3HttpClient, type S3ClientConfig } from "./api/client.js";
import type { PresignUrlOptions } from "./auth/signer.js";

export interface S3ProviderConfig extends S3ClientConfig {
  rootPrefix?: string;
}

/**
 * S3CompatibleProvider — Multi-cloud adapter for AWS S3, Cloudflare R2, MinIO, and Wasabi.
 */
export class S3CompatibleProvider implements BYOCProvider {
  public readonly http: S3HttpClient;
  public readonly rootPrefix: string;

  constructor(public readonly config: S3ProviderConfig) {
    if (!config || !config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "S3CompatibleProvider requires endpoint, bucket, accessKeyId, and secretAccessKey.",
        provider: "s3-compatible",
        retryable: false
      });
    }

    this.rootPrefix = config.rootPrefix ? normalizeVirtualPath(config.rootPrefix) : "";
    this.http = new S3HttpClient(config);
  }

  public manifest(): ProviderManifest {
    return {
      id: "s3-compatible",
      name: "S3 Compatible (R2/AWS/MinIO)",
      category: "developer-cloud",
      authentication: "access-key",
      supportsUserOwnedStorage: false,
      adapterVersion: "0.4.0"
    };
  }

  public capabilities(): ProviderCapabilities {
    return {
      folders: false,
      sharing: false,
      publicUrls: true,
      resumableUploads: false, // High-level automatic multipart orchestration is planned for v0.2.0
      versioning: true,
      quota: false,
      serverSideCopy: true,
      directUpload: true
    };
  }

  public async connect(): Promise<void> {
    // S3 uses stateless SigV4 request signatures
  }

  public async disconnect(): Promise<void> {
    // Stateless
  }

  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const key = this.toKey(path);
    const result = await this.http.putObject(
      key,
      data,
      options?.mimeType,
      options?.metadata as Record<string, string>,
      options?.onProgress,
      options?.contentLength
    );
    return {
      ...result,
      path: normalizeVirtualPath(path)
    };
  }

  public async download(path: string): Promise<StorageOutput> {
    const key = this.toKey(path);
    const res = await this.http.getObject(key);

    return {
      stream: res.body as any,
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
      metadata: {
        id: `s3_${this.config.bucket}_${key}`,
        path: normalizeVirtualPath(path),
        name: path.split("/").pop() || path,
        provider: "s3-compatible",
        providerId: key,
        size: Number(res.headers.get("content-length")) || undefined,
        mimeType: res.headers.get("content-type") || "application/octet-stream",
        checksum: res.headers.get("etag")?.replace(/"/g, "")
      }
    };
  }

  public async delete(path: string): Promise<void> {
    const key = this.toKey(path);
    await this.http.deleteObject(key);
  }

  public async list(path?: string): Promise<StorageObject[]> {
    const key = path ? this.toKey(path) : this.rootPrefix;
    return this.http.listObjects(key, "/", this.rootPrefix);
  }

  public async exists(path: string): Promise<boolean> {
    const key = this.toKey(path);
    try {
      await this.http.headObject(key);
      return true;
    } catch (err) {
      if (StorageError.isStorageError(err) && err.code === BYOCErrorCode.OBJECT_NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  public async metadata(path: string): Promise<StorageObject> {
    const key = this.toKey(path);
    const result = await this.http.headObject(key);
    return {
      ...result,
      path: normalizeVirtualPath(path)
    };
  }

  /**
   * Instant server-side copy within the S3 bucket using x-amz-copy-source.
   */
  public async copy(source: string, destination: string): Promise<void> {
    const sourceKey = this.toKey(source);
    const destKey = this.toKey(destination);
    await this.http.copyObject(sourceKey, destKey);
  }

  /**
   * Instant server-side move (atomic copy + delete source).
   */
  public async move(source: string, destination: string): Promise<void> {
    await this.copy(source, destination);
    await this.delete(source);
  }

  /**
   * Generates a SigV4 Presigned URL for direct secure browser client uploads or downloads.
   */
  public getSignedUrl(path: string, options?: PresignUrlOptions): string {
    const key = this.toKey(path);
    return this.http.getPresignedUrl(key, options);
  }

  /**
   * Mints a presigned PUT the browser uploads to directly.
   *
   * The signature covers `host` only and declares UNSIGNED-PAYLOAD, so the
   * browser does not have to reproduce any header exactly -- a mismatch there
   * is the usual cause of a 403 on direct upload. Nothing in the returned
   * grant contains this application's credentials; the URL itself is the
   * capability, and it expires.
   *
   * The bucket needs CORS allowing PUT from your origin, otherwise the browser
   * blocks the request before it is sent. See docs/direct-upload.md.
   */
  public async createUploadGrant(
    path: string,
    options: UploadGrantOptions = {}
  ): Promise<UploadGrant> {
    const expiresInSeconds = options.expiresInSeconds ?? 900;
    const key = this.toKey(path);

    return {
      provider: "s3-compatible",
      path: normalizeVirtualPath(path),
      url: this.http.getPresignedUrl(key, { method: "PUT", expiresInSeconds }),
      method: "PUT",
      // Deliberately empty: any header signed here becomes one the browser is
      // obliged to send byte-for-byte.
      headers: {},
      protocol: "single",
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000)
    };
  }

  public async backup(payload: StorageInput, options?: BackupOptions): Promise<StorageObject> {
    const folder = normalizeVirtualPath(options?.folder ?? "Backups");
    const filename = options?.filename ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const targetPath = folder ? `${folder}/${filename}` : filename;

    return this.upload(targetPath, payload, {
      mimeType: options?.mimeType ?? "application/json",
      onProgress: options?.onProgress
    });
  }

  private toKey(path: string): string {
    const normalized = normalizeVirtualPath(path);
    if (!this.rootPrefix) return normalized;
    return `${this.rootPrefix}/${normalized}`;
  }
}
