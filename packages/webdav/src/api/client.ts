import {
  withRetry,
  StorageError,
  BYOCErrorCode,
  encodePathSegments,
  type StorageObject,
  type StorageInput,
  type StorageQuota,
  type UploadProgress
} from "@byoc/core";
import { Readable } from "node:stream";

export interface WebDAVClientConfig {
  endpoint: string;
  username?: string;
  password?: string;
  token?: string;
}

export class WebDAVHttpClient {
  private readonly baseUrl: string;

  constructor(public readonly config: WebDAVClientConfig) {
    this.baseUrl = config.endpoint.replace(/\/+$/, "");
  }

  private getAuthHeader(): string | undefined {
    if (this.config.token) {
      return `Bearer ${this.config.token}`;
    }
    if (this.config.username && this.config.password) {
      const creds = `${this.config.username}:${this.config.password}`;
      return `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    return undefined;
  }

  public getFullUrl(path: string): string {
    const encoded = encodePathSegments(path);
    return `${this.baseUrl}/${encoded}`;
  }

  public async put(
    path: string,
    data: StorageInput,
    mimeType?: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<StorageObject> {
    const url = this.getFullUrl(path);
    let bodyPayload: any;
    let payloadSize: number | undefined;

    if (typeof data === "string") {
      const bytes = new TextEncoder().encode(data);
      bodyPayload = bytes;
      payloadSize = bytes.byteLength;
    } else if (data instanceof Uint8Array) {
      bodyPayload = data;
      payloadSize = data.byteLength;
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      bodyPayload = data;
      payloadSize = data.byteLength;
    } else if (data instanceof ArrayBuffer) {
      bodyPayload = new Uint8Array(data);
      payloadSize = data.byteLength;
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      bodyPayload = data;
      payloadSize = data.size;
    } else if (
      (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) ||
      (typeof Readable !== "undefined" && data instanceof Readable)
    ) {
      bodyPayload = data;
    } else {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Unsupported data payload type for WebDAV upload.",
        provider: "webdav"
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": mimeType || "application/octet-stream"
    };

    if (payloadSize !== undefined) {
      headers["Content-Length"] = String(payloadSize);
    }

    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: bodyPayload,
        // @ts-ignore Node fetch streaming support
        duplex: "half"
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      if (onProgress && payloadSize !== undefined) {
        onProgress({
          bytesUploaded: payloadSize,
          totalBytes: payloadSize,
          percentage: 100
        });
      }

      const etag = response.headers.get("etag")?.replace(/"/g, "");

      return {
        id: `webdav_${path}`,
        path,
        name: path.split("/").pop() || path,
        provider: "webdav",
        providerId: path,
        size: payloadSize,
        mimeType: mimeType || "application/octet-stream",
        checksum: etag,
        updatedAt: new Date()
      };
    });
  }

  public async get(path: string): Promise<Response> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {};
    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "GET",
        headers
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      return response;
    });
  }

  public async delete(path: string): Promise<void> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {};
    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    await withRetry(async () => {
      const response = await fetch(url, {
        method: "DELETE",
        headers
      });

      if (!response.ok && response.status !== 404 && response.status !== 204) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  public async mkcol(path: string): Promise<void> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {};
    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    await withRetry(async () => {
      const response = await fetch(url, {
        method: "MKCOL",
        headers
      });

      // 201 Created or 405 (Folder already exists) are successful
      if (!response.ok && response.status !== 405 && response.status !== 301) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  public async head(path: string): Promise<StorageObject> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {};
    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "HEAD",
        headers
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const contentLength = response.headers.get("content-length");
      const etag = response.headers.get("etag")?.replace(/"/g, "");
      const lastModified = response.headers.get("last-modified");

      return {
        id: `webdav_${path}`,
        path,
        name: path.split("/").pop() || path,
        provider: "webdav",
        providerId: path,
        size: contentLength ? Number(contentLength) : undefined,
        mimeType: contentType,
        checksum: etag,
        updatedAt: lastModified ? new Date(lastModified) : undefined
      };
    });
  }

  public async copy(sourcePath: string, destPath: string, overwrite: boolean = true): Promise<void> {
    const sourceUrl = this.getFullUrl(sourcePath);
    const destUrl = this.getFullUrl(destPath);
    const headers: Record<string, string> = {
      Destination: destUrl,
      Overwrite: overwrite ? "T" : "F"
    };

    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    await withRetry(async () => {
      const response = await fetch(sourceUrl, {
        method: "COPY",
        headers
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  public async move(sourcePath: string, destPath: string, overwrite: boolean = true): Promise<void> {
    const sourceUrl = this.getFullUrl(sourcePath);
    const destUrl = this.getFullUrl(destPath);
    const headers: Record<string, string> = {
      Destination: destUrl,
      Overwrite: overwrite ? "T" : "F"
    };

    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    await withRetry(async () => {
      const response = await fetch(sourceUrl, {
        method: "MOVE",
        headers
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  public async propfind(path: string, depth: number = 1, rootFolder: string = ""): Promise<StorageObject[]> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {
      Depth: String(depth),
      "Content-Type": "application/xml; charset=utf-8"
    };

    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "PROPFIND",
        headers
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const xmlText = await response.text();
      return parseWebDavPropfindXml(xmlText, path, rootFolder);
    });
  }

  /**
   * RFC 4331: Query storage quota via PROPFIND Depth: 0
   */
  public async getQuota(path: string = ""): Promise<StorageQuota> {
    const url = this.getFullUrl(path);
    const headers: Record<string, string> = {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8"
    };

    const auth = this.getAuthHeader();
    if (auth) headers["Authorization"] = auth;

    const queryBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:quota-available-bytes/>
    <d:quota-used-bytes/>
  </d:prop>
</d:propfind>`;

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "PROPFIND",
        headers,
        body: queryBody
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const xml = await response.text();
      const availMatch = xml.match(/<[a-zA-Z0-9:]*quota-available-bytes>(\d+)<\/[a-zA-Z0-9:]*quota-available-bytes>/i);
      const usedMatch = xml.match(/<[a-zA-Z0-9:]*quota-used-bytes>(\d+)<\/[a-zA-Z0-9:]*quota-used-bytes>/i);

      const available = availMatch && availMatch[1] ? Number(availMatch[1]) : undefined;
      const used = usedMatch && usedMatch[1] ? Number(usedMatch[1]) : 0;
      const total = available !== undefined ? used + available : undefined;

      return {
        used,
        total,
        available
      };
    });
  }

  private async handleErrorResponse(response: Response): Promise<StorageError> {
    const errorText = await response.text().catch(() => response.statusText);

    if (response.status === 404) {
      return new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: "WebDAV object not found (404).",
        provider: "webdav",
        statusCode: 404,
        retryable: false
      });
    }

    if (response.status === 401 || response.status === 403) {
      return new StorageError({
        code: BYOCErrorCode.PERMISSION_DENIED,
        message: "WebDAV authentication failed: Invalid credentials or permission denied.",
        provider: "webdav",
        statusCode: response.status,
        retryable: false
      });
    }

    if (response.status === 507) {
      return new StorageError({
        code: BYOCErrorCode.QUOTA_EXCEEDED,
        message: "WebDAV insufficient storage / user quota exceeded (507).",
        provider: "webdav",
        statusCode: 507,
        retryable: false
      });
    }

    return new StorageError({
      code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
      message: `WebDAV Server Error (${response.status}): ${errorText}`,
      provider: "webdav",
      statusCode: response.status,
      retryable: response.status >= 500
    });
  }
}

/**
 * Parses WebDAV PROPFIND Multistatus XML responses extracting child files and folders.
 */
export function parseWebDavPropfindXml(xml: string, targetPath: string, rootFolder: string = ""): StorageObject[] {
  const results: StorageObject[] = [];
  const cleanTarget = targetPath.replace(/^\/+|\/+$/g, "");

  const responseMatches = xml.matchAll(/<[a-zA-Z0-9:]*response>([\s\S]*?)<\/[a-zA-Z0-9:]*response>/g);

  for (const match of responseMatches) {
    const block = match[1] || "";
    const hrefMatch = block.match(/<[a-zA-Z0-9:]*href>(.*?)<\/[a-zA-Z0-9:]*href>/);
    if (!hrefMatch || !hrefMatch[1]) continue;

    const rawHref = decodeURI(hrefMatch[1]);
    const normalizedHref = rawHref.replace(/\/+$/, "");
    const segments = normalizedHref.split("/").filter(Boolean);
    const itemName = segments[segments.length - 1] || "";

    // Skip the parent directory self-reference
    if (!itemName || normalizedHref.endsWith(cleanTarget)) {
      continue;
    }

    const isFolder = /<[a-zA-Z0-9:]*collection\s*\/?>/i.test(block);
    const sizeMatch = block.match(/<[a-zA-Z0-9:]*getcontentlength>(\d+)<\/[a-zA-Z0-9:]*getcontentlength>/);
    const typeMatch = block.match(/<[a-zA-Z0-9:]*getcontenttype>(.*?)<\/[a-zA-Z0-9:]*getcontenttype>/);
    const etagMatch = block.match(/<[a-zA-Z0-9:]*getetag>(.*?)<\/[a-zA-Z0-9:]*getetag>/);
    const lastModMatch = block.match(/<[a-zA-Z0-9:]*getlastmodified>(.*?)<\/[a-zA-Z0-9:]*getlastmodified>/);

    const relativePath = cleanTarget ? `${cleanTarget}/${itemName}` : itemName;
    const cleanRoot = rootFolder.replace(/^\/+|\/+$/g, "");
    const virtualPath = cleanRoot && relativePath.startsWith(cleanRoot + "/")
      ? relativePath.substring(cleanRoot.length + 1)
      : cleanRoot && relativePath === cleanRoot
        ? ""
        : relativePath;

    results.push({
      id: `webdav_${relativePath}`,
      path: virtualPath,
      name: itemName,
      provider: "webdav",
      providerId: relativePath,
      type: isFolder ? "folder" : "file",
      size: sizeMatch && sizeMatch[1] ? Number(sizeMatch[1]) : undefined,
      mimeType: typeMatch && typeMatch[1] ? typeMatch[1].trim() : isFolder ? undefined : "application/octet-stream",
      checksum: etagMatch && etagMatch[1] ? etagMatch[1].replace(/"/g, "") : undefined,
      updatedAt: lastModMatch && lastModMatch[1] ? new Date(lastModMatch[1]) : undefined
    });
  }

  return results;
}
