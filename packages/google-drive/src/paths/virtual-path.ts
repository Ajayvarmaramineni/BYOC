import { BYOCErrorCode, StorageError, getBasename, getDirname, normalizeVirtualPath } from "@byoc/core";
import type { DriveHttpClient } from "../api/http.js";

/**
 * Resolved object reference within Google Drive.
 */
export interface GoogleDriveResolvedNode {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly isFolder: boolean;
  readonly mimeType?: string;
  readonly size?: number;
}

/**
 * Interface for caching virtual path -> Google Drive file/folder ID mappings.
 */
export interface PathCache {
  get(path: string): Promise<string | undefined> | string | undefined;
  set(path: string, id: string): Promise<void> | void;
  delete(path: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface CacheOptions {
  /** Time-to-live in milliseconds for cached path entries (default: 5 minutes) */
  ttlMs?: number;
  /** Maximum number of paths retained in memory (default: 1000) */
  maxSize?: number;
}

interface CacheEntry {
  id: string;
  expiresAt: number;
}

/**
 * High-performance LRU + TTL Path Cache for Google Drive virtual paths.
 */
export class LruTtlPathCache implements PathCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize ?? 1000;
  }

  public get(path: string): string | undefined {
    const entry = this.cache.get(path);
    if (!entry) return undefined;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(path);
      return undefined;
    }

    // Refresh LRU order
    this.cache.delete(path);
    this.cache.set(path, entry);

    return entry.id;
  }

  public set(path: string, id: string): void {
    if (this.cache.has(path)) {
      this.cache.delete(path);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first item in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(path, {
      id,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  public delete(path: string): void {
    this.cache.delete(path);
  }

  public clear(): void {
    this.cache.clear();
  }
}

/**
 * Backward-compatible InMemoryPathCache alias.
 */
export class InMemoryPathCache extends LruTtlPathCache {}

/**
 * Escapes characters for Google Drive query string parameters.
 * According to Drive API v3 documentation, single quotes and backslashes must be escaped with a backslash.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * GoogleDrivePathResolver — Maps virtual POSIX paths to Google Drive folder/file node IDs,
 * automatically creating nested hierarchies and recovering from out-of-band Drive modifications.
 */
export class GoogleDrivePathResolver {
  private rootFolderId?: string;

  constructor(
    private readonly http: DriveHttpClient,
    private readonly rootFolderName: string = "BYOC",
    private readonly cache: PathCache = new LruTtlPathCache()
  ) {}

  /**
   * Resolves or creates the root application folder in Google Drive.
   */
  public async ensureRootFolder(forceRefresh: boolean = false): Promise<string> {
    if (this.rootFolderId && !forceRefresh) {
      return this.rootFolderId;
    }

    const cachedRoot = await this.cache.get("__ROOT__");
    if (cachedRoot && !forceRefresh) {
      this.rootFolderId = cachedRoot;
      return cachedRoot;
    }

    const folderName = this.rootFolderName || "BYOC";
    const escapedName = escapeDriveQueryValue(folderName);
    const query = `name = '${escapedName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const listRes = await this.http.listFiles(query, 1);

    if (listRes.files && listRes.files.length > 0 && listRes.files[0]) {
      this.rootFolderId = listRes.files[0].id;
      await this.cache.set("__ROOT__", this.rootFolderId);
      return this.rootFolderId;
    }

    // Create root folder under Drive root
    const created = await this.http.createFolder(folderName, "root");
    this.rootFolderId = created.id;
    await this.cache.set("__ROOT__", this.rootFolderId);
    return this.rootFolderId;
  }

  /**
   * Resolves the parent folder ID for a virtual path, creating any missing intermediate folders.
   */
  public async resolveParentFolderId(virtualPath: string): Promise<string> {
    const normalized = normalizeVirtualPath(virtualPath);
    const dirname = getDirname(normalized);

    if (!dirname) {
      return this.ensureRootFolder();
    }

    return this.resolveOrCreateFolderPath(dirname);
  }

  /**
   * Recursively resolves or creates a folder path structure (e.g. "users/123/documents").
   */
  public async resolveOrCreateFolderPath(folderPath: string): Promise<string> {
    const normalized = normalizeVirtualPath(folderPath);
    if (!normalized) {
      return this.ensureRootFolder();
    }

    const cached = await this.cache.get(normalized);
    if (cached) return cached;

    const segments = normalized.split("/");
    let currentParentId = await this.ensureRootFolder();
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const segmentCached = await this.cache.get(currentPath);

      if (segmentCached) {
        currentParentId = segmentCached;
        continue;
      }

      // Search for folder under current parent with query escaping
      const escapedSegment = escapeDriveQueryValue(segment);
      const query = `name = '${escapedSegment}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const listRes = await this.http.listFiles(query, 5);

      if (listRes.files && listRes.files.length > 0 && listRes.files[0]) {
        // Pick newest if duplicates exist
        currentParentId = listRes.files[0].id;
      } else {
        const created = await this.http.createFolder(segment, currentParentId);
        currentParentId = created.id;
      }

      await this.cache.set(currentPath, currentParentId);
    }

    return currentParentId;
  }

  /**
   * Resolves a file ID from its virtual path.
   * If `skipCache` is true, queries Google Drive directly.
   */
  public async resolveFileId(
    virtualPath: string,
    options: { skipCache?: boolean } = {}
  ): Promise<string> {
    const normalized = normalizeVirtualPath(virtualPath);
    if (!normalized) {
      return this.ensureRootFolder();
    }

    if (!options.skipCache) {
      const cached = await this.cache.get(normalized);
      if (cached) return cached;
    }

    const filename = getBasename(normalized);
    const parentFolderId = await this.resolveParentFolderId(normalized);

    const escapedFilename = escapeDriveQueryValue(filename);
    const query = `name = '${escapedFilename}' and '${parentFolderId}' in parents and trashed = false`;
    const listRes = await this.http.listFiles(query, 10);

    if (!listRes.files || listRes.files.length === 0 || !listRes.files[0]) {
      await this.cache.delete(normalized);
      throw new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: `Object not found at path: "${normalized}"`,
        provider: "google-drive",
        statusCode: 404,
        retryable: false
      });
    }

    // Sort by modifiedTime descending if duplicate filenames exist
    const sortedFiles = [...listRes.files].sort((a, b) => {
      const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
      const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
      return timeB - timeA;
    });

    const fileId = sortedFiles[0]!.id;
    await this.cache.set(normalized, fileId);
    return fileId;
  }

  /**
   * Invalidate cached mapping for a path (used when 404 is encountered).
   */
  public async invalidate(virtualPath: string): Promise<void> {
    const normalized = normalizeVirtualPath(virtualPath);
    await this.cache.delete(normalized);
  }

  /**
   * Set or update cached mapping for a virtual path.
   */
  public async setCached(virtualPath: string, fileId: string): Promise<void> {
    const normalized = normalizeVirtualPath(virtualPath);
    await this.cache.set(normalized, fileId);
  }

  /**
   * Clears entire path cache (e.g. on disconnect or account switch).
   */
  public async clearCache(): Promise<void> {
    this.rootFolderId = undefined;
    await this.cache.clear();
  }
}
