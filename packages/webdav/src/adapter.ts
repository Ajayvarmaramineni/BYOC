import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest,
  StorageInput,
  StorageObject,
  StorageOutput,
  UploadOptions,
  BackupOptions,
  StorageQuota
} from "@byoc/core";
import {
  BYOCErrorCode,
  StorageError,
  normalizeVirtualPath,
  getBasename,
  getDirname
} from "@byoc/core";
import { WebDAVHttpClient, type WebDAVClientConfig } from "./api/client.js";

export interface WebDAVProviderConfig extends WebDAVClientConfig {
  rootFolder?: string;
}

/**
 * WebDAVProvider — Self-hosted storage adapter for Nextcloud, ownCloud, and Synology NAS.
 */
export class WebDAVProvider implements BYOCProvider {
  public readonly http: WebDAVHttpClient;
  public readonly rootFolder: string;

  constructor(public readonly config: WebDAVProviderConfig) {
    if (!config || !config.endpoint) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "WebDAVProvider requires an 'endpoint' URL.",
        provider: "webdav",
        retryable: false
      });
    }

    this.rootFolder = config.rootFolder ? normalizeVirtualPath(config.rootFolder) : "BYOC";
    this.http = new WebDAVHttpClient(config);
  }

  public manifest(): ProviderManifest {
    return {
      id: "webdav",
      name: "Nextcloud / WebDAV",
      category: "self-hosted",
      authentication: this.config.token ? "oauth2" : "basic",
      supportsUserOwnedStorage: true,
      adapterVersion: "0.3.0"
    };
  }

  public capabilities(): ProviderCapabilities {
    return {
      folders: true,
      sharing: false,
      publicUrls: false,
      resumableUploads: false,
      versioning: false,
      quota: true,
      serverSideCopy: true
    };
  }

  public async connect(): Promise<void> {
    // Validate connection / auth credentials and ensure root app folder exists on Nextcloud / WebDAV
    if (this.rootFolder) {
      try {
        await this.http.mkcol(this.rootFolder);
      } catch (err) {
        // 405 (Folder already exists) or 301 is acceptable; authentication/network errors must be thrown
        if (StorageError.isStorageError(err) && (err.statusCode === 405 || err.statusCode === 301)) {
          return;
        }
        throw err;
      }
    } else {
      // If no root folder, verify connection with lightweight PROPFIND Depth 0
      await this.http.propfind("", 0);
    }
  }

  public async disconnect(): Promise<void> {
    // Stateless
  }

  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const fullPath = this.toFullPath(path);
    const dirname = getDirname(fullPath);

    if (dirname) {
      await this.ensureFolderHierarchy(dirname);
    }

    const result = await this.http.put(fullPath, data, options?.mimeType, options?.onProgress);
    return {
      ...result,
      path: normalizeVirtualPath(path)
    };
  }

  public async download(path: string): Promise<StorageOutput> {
    const fullPath = this.toFullPath(path);
    const res = await this.http.get(fullPath);

    return {
      stream: res.body as any,
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
      metadata: {
        id: `webdav_${fullPath}`,
        path: normalizeVirtualPath(path),
        name: getBasename(fullPath),
        provider: "webdav",
        providerId: fullPath,
        size: Number(res.headers.get("content-length")) || undefined,
        mimeType: res.headers.get("content-type") || "application/octet-stream",
        checksum: res.headers.get("etag")?.replace(/"/g, "")
      }
    };
  }

  public async delete(path: string): Promise<void> {
    const fullPath = this.toFullPath(path);
    await this.http.delete(fullPath);
  }

  public async list(path?: string): Promise<StorageObject[]> {
    const fullPath = path ? this.toFullPath(path) : this.rootFolder;
    return this.http.propfind(fullPath, 1, this.rootFolder);
  }

  public async exists(path: string): Promise<boolean> {
    const fullPath = this.toFullPath(path);
    try {
      await this.http.head(fullPath);
      return true;
    } catch (err) {
      if (StorageError.isStorageError(err) && err.code === BYOCErrorCode.OBJECT_NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  public async metadata(path: string): Promise<StorageObject> {
    const fullPath = this.toFullPath(path);
    const result = await this.http.head(fullPath);
    return {
      ...result,
      path: normalizeVirtualPath(path)
    };
  }

  public async createFolder(path: string): Promise<StorageObject> {
    const fullPath = this.toFullPath(path);
    await this.ensureFolderHierarchy(fullPath);
    return {
      id: `webdav_${fullPath}`,
      path: normalizeVirtualPath(path),
      name: getBasename(fullPath),
      provider: "webdav",
      providerId: fullPath,
      type: "folder"
    };
  }

  /**
   * RFC 2518: Server-side file/folder copy
   */
  public async copy(source: string, destination: string): Promise<void> {
    const src = this.toFullPath(source);
    const dest = this.toFullPath(destination);
    const dirname = getDirname(dest);
    if (dirname) {
      await this.ensureFolderHierarchy(dirname);
    }
    await this.http.copy(src, dest);
  }

  /**
   * RFC 2518: Server-side file/folder move
   */
  public async move(source: string, destination: string): Promise<void> {
    const src = this.toFullPath(source);
    const dest = this.toFullPath(destination);
    const dirname = getDirname(dest);
    if (dirname) {
      await this.ensureFolderHierarchy(dirname);
    }
    await this.http.move(src, dest);
  }

  /**
   * RFC 4331: Query user quota
   */
  public async quota(): Promise<StorageQuota> {
    return this.http.getQuota(this.rootFolder);
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

  private toFullPath(path: string): string {
    const normalized = normalizeVirtualPath(path);
    if (!this.rootFolder) return normalized;
    return `${this.rootFolder}/${normalized}`;
  }

  private async ensureFolderHierarchy(folderPath: string): Promise<void> {
    const segments = folderPath.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      await this.http.mkcol(current);
    }
  }
}
