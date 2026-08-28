import {
  withRetry,
  StorageError,
  BYOCErrorCode,
  type StorageObject,
  type StorageInput,
  type UploadProgress
} from "@byoc/core";
import {
  signS3Request,
  createPresignedS3Url,
  rfc3986UriEncode,
  type SigV4Options,
  type PresignUrlOptions
} from "../auth/signer.js";
import { Readable } from "node:stream";

export interface S3ClientConfig extends SigV4Options {
  endpoint: string;
  bucket: string;
  forcePathStyle?: boolean;
}

export interface S3UploadPart {
  partNumber: number;
  etag: string;
}

export class S3HttpClient {
  constructor(public readonly config: S3ClientConfig) {}

  /**
   * Automatically determines whether path-style addressing is required.
   * If the endpoint hostname starts with `${bucket}.`, it is virtual-host.
   * Otherwise (e.g. s3.us-east-1.amazonaws.com, r2.cloudflarestorage.com, localhost),
   * path-style (https://<endpoint>/<bucket>/<key>) is used.
   */
  public isPathStyle(): boolean {
    if (typeof this.config.forcePathStyle === "boolean") {
      return this.config.forcePathStyle;
    }
    const host = new URL(this.config.endpoint).host.toLowerCase();
    const bucketPrefix = `${this.config.bucket.toLowerCase()}.`;
    return !host.startsWith(bucketPrefix);
  }

  public getObjectUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    const encodedKey = cleanKey
      .split("/")
      .map((segment) => rfc3986UriEncode(segment, true))
      .join("/");
    const base = this.config.endpoint.replace(/\/+$/, "");

    if (this.isPathStyle()) {
      return `${base}/${this.config.bucket}/${encodedKey}`;
    }
    return `${base}/${encodedKey}`;
  }

  public getBucketBaseUrl(): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    if (this.isPathStyle()) {
      return `${base}/${this.config.bucket}`;
    }
    return base;
  }

  public async putObject(
    key: string,
    data: StorageInput,
    mimeType?: string,
    metadata?: Record<string, string>,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<StorageObject> {
    const url = this.getObjectUrl(key);
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
        message: "Unsupported data payload type for S3 upload.",
        provider: "s3-compatible"
      });
    }

    const headers: Record<string, string> = {
      "content-type": mimeType || "application/octet-stream"
    };

    if (payloadSize !== undefined) {
      headers["content-length"] = String(payloadSize);
    }

    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      }
    }

    const signedHeaders = signS3Request(this.config, {
      method: "PUT",
      url,
      headers,
      body: typeof bodyPayload === "string" || bodyPayload instanceof Uint8Array ? bodyPayload : undefined
    });

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "PUT",
        headers: signedHeaders,
        body: bodyPayload,
        // @ts-ignore Node fetch streaming requires duplex: 'half'
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

      const etag = response.headers.get("etag")?.replace(/"/g, "") || undefined;

      return {
        id: `s3_${this.config.bucket}_${key}`,
        path: key,
        name: key.split("/").pop() || key,
        provider: "s3-compatible",
        providerId: key,
        size: payloadSize,
        mimeType: mimeType || "application/octet-stream",
        checksum: etag,
        updatedAt: new Date()
      };
    });
  }

  public async getObject(key: string): Promise<Response> {
    const url = this.getObjectUrl(key);
    const signedHeaders = signS3Request(this.config, {
      method: "GET",
      url
    });

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "GET",
        headers: signedHeaders
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      return response;
    });
  }

  public async deleteObject(key: string): Promise<void> {
    const url = this.getObjectUrl(key);
    const signedHeaders = signS3Request(this.config, {
      method: "DELETE",
      url
    });

    await withRetry(async () => {
      const response = await fetch(url, {
        method: "DELETE",
        headers: signedHeaders
      });

      if (!response.ok && response.status !== 404 && response.status !== 204) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  public async headObject(key: string): Promise<StorageObject> {
    const url = this.getObjectUrl(key);
    const signedHeaders = signS3Request(this.config, {
      method: "HEAD",
      url
    });

    return withRetry(async () => {
      const response = await fetch(url, {
        method: "HEAD",
        headers: signedHeaders
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const contentLength = response.headers.get("content-length");
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const etag = response.headers.get("etag")?.replace(/"/g, "");
      const lastModified = response.headers.get("last-modified");

      return {
        id: `s3_${this.config.bucket}_${key}`,
        path: key,
        name: key.split("/").pop() || key,
        provider: "s3-compatible",
        providerId: key,
        size: contentLength ? Number(contentLength) : undefined,
        mimeType: contentType,
        checksum: etag,
        updatedAt: lastModified ? new Date(lastModified) : undefined
      };
    });
  }

  public async listObjects(prefix?: string, delimiter: string = "/", rootPrefix: string = ""): Promise<StorageObject[]> {
    const allResults: StorageObject[] = [];
    let continuationToken: string | undefined = undefined;

    do {
      const base = this.getBucketBaseUrl();
      const url = new URL(base.endsWith("/") ? base : `${base}/`);
      url.searchParams.set("list-type", "2");

      if (prefix) {
        const cleanPrefix = prefix.replace(/^\/+/, "");
        url.searchParams.set("prefix", cleanPrefix.endsWith("/") ? cleanPrefix : `${cleanPrefix}/`);
      }

      if (delimiter) {
        url.searchParams.set("delimiter", delimiter);
      }

      if (continuationToken) {
        url.searchParams.set("continuation-token", continuationToken);
      }

      const signedHeaders = signS3Request(this.config, {
        method: "GET",
        url: url.toString()
      });

      const pageXml = await withRetry(async () => {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: signedHeaders
        });

        if (!response.ok) {
          throw await this.handleErrorResponse(response);
        }

        return response.text();
      });

      const pageResults = parseS3ListXml(pageXml, this.config.bucket, rootPrefix);
      allResults.push(...pageResults);

      const isTruncatedMatch = pageXml.match(/<IsTruncated>(true|false)<\/IsTruncated>/i);
      const isTruncated = isTruncatedMatch ? isTruncatedMatch[1]?.toLowerCase() === "true" : false;

      if (isTruncated) {
        const tokenMatch = pageXml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
        continuationToken = tokenMatch && tokenMatch[1] ? tokenMatch[1] : undefined;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    return allResults;
  }

  /**
   * Executes an instantaneous server-side copy using x-amz-copy-source.
   */
  public async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const destUrl = this.getObjectUrl(destKey);
    const cleanSourceKey = sourceKey.replace(/^\/+/, "");
    // Encode per segment, not with encodeURI: encodeURI leaves `#` and `?`
    // intact, so a copy source like `draft#2.pdf` truncates at the `#` and S3
    // reports the object missing. This is the same rule getObjectUrl follows.
    const encodedSourceKey = cleanSourceKey
      .split("/")
      .map((segment) => rfc3986UriEncode(segment, true))
      .join("/");
    const copySourceHeader = `/${this.config.bucket}/${encodedSourceKey}`;

    const signedHeaders = signS3Request(this.config, {
      method: "PUT",
      url: destUrl,
      headers: {
        "x-amz-copy-source": copySourceHeader
      }
    });

    await withRetry(async () => {
      const response = await fetch(destUrl, {
        method: "PUT",
        headers: signedHeaders
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  /**
   * S3 Multipart Upload: Initiate
   */
  public async createMultipartUpload(key: string, mimeType?: string): Promise<string> {
    const url = new URL(this.getObjectUrl(key));
    url.searchParams.set("uploads", "");

    const signedHeaders = signS3Request(this.config, {
      method: "POST",
      url: url.toString(),
      headers: {
        "content-type": mimeType || "application/octet-stream"
      }
    });

    return withRetry(async () => {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: signedHeaders
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const xml = await response.text();
      const match = xml.match(/<UploadId>(.*?)<\/UploadId>/);
      if (!match || !match[1]) {
        throw new StorageError({
          code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
          message: "Failed to parse S3 Multipart UploadId response.",
          provider: "s3-compatible"
        });
      }

      return match[1];
    });
  }

  /**
   * S3 Multipart Upload: Upload a single chunk part
   */
  public async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    data: Uint8Array
  ): Promise<S3UploadPart> {
    const url = new URL(this.getObjectUrl(key));
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);

    const signedHeaders = signS3Request(this.config, {
      method: "PUT",
      url: url.toString(),
      body: data
    });

    return withRetry(async () => {
      const response = await fetch(url.toString(), {
        method: "PUT",
        headers: signedHeaders,
        body: data as any
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      const etag = response.headers.get("etag")?.replace(/"/g, "");
      if (!etag) {
        throw new StorageError({
          code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
          message: `S3 UploadPart ${partNumber} did not return an ETag header.`,
          provider: "s3-compatible"
        });
      }

      return { partNumber, etag };
    });
  }

  /**
   * S3 Multipart Upload: Complete and commit parts
   */
  public async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: S3UploadPart[]
  ): Promise<StorageObject> {
    const url = new URL(this.getObjectUrl(key));
    url.searchParams.set("uploadId", uploadId);

    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const xmlPayload = [
      "<CompleteMultipartUpload>",
      ...sortedParts.map((p) => `  <Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`),
      "</CompleteMultipartUpload>"
    ].join("\n");

    const signedHeaders = signS3Request(this.config, {
      method: "POST",
      url: url.toString(),
      headers: { "content-type": "application/xml" },
      body: xmlPayload
    });

    return withRetry(async () => {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: signedHeaders,
        body: xmlPayload
      });

      if (!response.ok) {
        throw await this.handleErrorResponse(response);
      }

      return {
        id: `s3_${this.config.bucket}_${key}`,
        path: key,
        name: key.split("/").pop() || key,
        provider: "s3-compatible",
        providerId: key,
        updatedAt: new Date()
      };
    });
  }

  /**
   * S3 Multipart Upload: Abort and purge incomplete parts
   */
  public async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = new URL(this.getObjectUrl(key));
    url.searchParams.set("uploadId", uploadId);

    const signedHeaders = signS3Request(this.config, {
      method: "DELETE",
      url: url.toString()
    });

    await withRetry(async () => {
      const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: signedHeaders
      });

      if (!response.ok && response.status !== 404) {
        throw await this.handleErrorResponse(response);
      }
    });
  }

  /**
   * Generates a SigV4 Presigned Download or Upload URL.
   */
  public getPresignedUrl(key: string, options: PresignUrlOptions = {}): string {
    const url = this.getObjectUrl(key);
    return createPresignedS3Url(this.config, url, options);
  }

  private async handleErrorResponse(response: Response): Promise<StorageError> {
    let errorText = "";
    try {
      errorText = await response.text();
    } catch {
      errorText = response.statusText;
    }

    if (response.status === 404 || errorText.includes("NoSuchKey")) {
      return new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: `S3 Object not found (Status 404)`,
        provider: "s3-compatible",
        statusCode: 404,
        retryable: false
      });
    }

    if (response.status === 403 || errorText.includes("AccessDenied")) {
      return new StorageError({
        code: BYOCErrorCode.PERMISSION_DENIED,
        message: "S3 Access Denied: Invalid credentials or insufficient permissions.",
        provider: "s3-compatible",
        statusCode: 403,
        retryable: false
      });
    }

    return new StorageError({
      code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
      message: `S3 Error (${response.status}): ${errorText}`,
      provider: "s3-compatible",
      statusCode: response.status,
      retryable: response.status >= 500
    });
  }
}

/**
 * Parses S3 ListObjectsV2 XML responses extracting files and virtual folder prefixes.
 */
export function parseS3ListXml(xml: string, bucket: string, rootPrefix: string = ""): StorageObject[] {
  const results: StorageObject[] = [];

  // Parse CommonPrefixes (Folders)
  const prefixMatches = xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g);
  for (const match of prefixMatches) {
    if (match[1]) {
      const fullKey = match[1].replace(/\/+$/, "");
      const virtualPath = rootPrefix && fullKey.startsWith(rootPrefix + "/") ? fullKey.substring(rootPrefix.length + 1) : fullKey;
      const name = virtualPath.split("/").pop() || virtualPath;
      results.push({
        id: `s3_${bucket}_${fullKey}`,
        path: virtualPath,
        name,
        provider: "s3-compatible",
        providerId: fullKey,
        type: "folder"
      });
    }
  }

  // Parse Contents (Files)
  const contentMatches = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
  for (const match of contentMatches) {
    const block = match[1] || "";
    const keyMatch = block.match(/<Key>(.*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const etagMatch = block.match(/<ETag>(.*?)<\/ETag>/);
    const lastModMatch = block.match(/<LastModified>(.*?)<\/LastModified>/);

    if (keyMatch && keyMatch[1]) {
      const fullKey = keyMatch[1];
      // Skip directory marker keys (e.g. "folder/")
      if (fullKey.endsWith("/")) continue;

      const virtualPath = rootPrefix && fullKey.startsWith(rootPrefix + "/") ? fullKey.substring(rootPrefix.length + 1) : fullKey;
      const name = virtualPath.split("/").pop() || virtualPath;

      results.push({
        id: `s3_${bucket}_${fullKey}`,
        path: virtualPath,
        name,
        provider: "s3-compatible",
        providerId: fullKey,
        type: "file",
        size: sizeMatch && sizeMatch[1] ? Number(sizeMatch[1]) : undefined,
        checksum: etagMatch && etagMatch[1] ? etagMatch[1].replace(/"/g, "") : undefined,
        updatedAt: lastModMatch && lastModMatch[1] ? new Date(lastModMatch[1]) : undefined
      });
    }
  }

  return results;
}
