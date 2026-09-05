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

/**
 * Bytes buffered per multipart part. S3's floor is 5 MiB for every part but
 * the last, so this cannot go below that.
 */
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export interface S3UploadPart {
  partNumber: number;
  etag: string;
}

/**
 * Adapts a web ReadableStream to an async iterable.
 *
 * Node's streams are async-iterable already, but a web ReadableStream only
 * gained that in newer runtimes, so this keeps the multipart path working on
 * both without a runtime check at every call site.
 */
async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
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
    onProgress?: (progress: UploadProgress) => void,
    contentLength?: number
  ): Promise<StorageObject> {
    const url = this.getObjectUrl(key);
    let bodyPayload: any;
    let payloadSize: number | undefined;
    let isStreaming = false;

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
      bodyPayload = new Uint8Array(await data.arrayBuffer());
      payloadSize = bodyPayload.byteLength;
    } else if (
      (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) ||
      (typeof Readable !== "undefined" && data instanceof Readable) ||
      // A bare async generator is neither of the above but is the most natural
      // way to write a producer in TypeScript, and StorageInput accepts it.
      typeof (data as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] === "function"
    ) {
      bodyPayload = data;
      isStreaming = true;
    } else {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Unsupported data payload type for S3 upload.",
        provider: "s3-compatible"
      });
    }

    if (contentLength !== undefined) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new StorageError({
          code: BYOCErrorCode.INVALID_INPUT,
          message: `S3 upload contentLength must be a non-negative safe integer (received ${contentLength}).`,
          provider: "s3-compatible",
          retryable: false
        });
      }
      if (payloadSize !== undefined && payloadSize !== contentLength) {
        throw new StorageError({
          code: BYOCErrorCode.INVALID_INPUT,
          message: `S3 upload contentLength ${contentLength} does not match the ${payloadSize}-byte input.`,
          provider: "s3-compatible",
          retryable: false
        });
      }
      payloadSize = contentLength;
    }
    if (isStreaming && payloadSize === undefined) {
      // A stream of unknown length goes up as a multipart upload: S3 answers
      // 411 Length Required to a chunked PUT, and every multipart part carries
      // its own Content-Length.
      const iterable =
        typeof (bodyPayload as ReadableStream).getReader === "function"
          ? streamToAsyncIterable(bodyPayload as ReadableStream<Uint8Array>)
          : (bodyPayload as AsyncIterable<Uint8Array>);

      const result = await this.putObjectStreaming(
        key,
        iterable,
        mimeType,
        metadata,
        onProgress
      );

      return {
        id: `s3_${this.config.bucket}_${key}`,
        path: key,
        name: key.split("/").pop() || key,
        provider: "s3-compatible",
        providerId: key,
        type: "file",
        size: result.size,
        mimeType: mimeType || "application/octet-stream",
        checksum: result.etag,
        updatedAt: new Date()
      };
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
      body: typeof bodyPayload === "string" || bodyPayload instanceof Uint8Array ? bodyPayload : undefined,
      payloadHash: isStreaming ? "UNSIGNED-PAYLOAD" : undefined
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
    }, {
      // A stream is a one-shot body. Retrying it without a provider-native
      // resumable session would silently resend only the unread suffix.
      maxRetries: isStreaming ? 0 : 3
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
  /**
   * Streams a body of unknown length to S3 as a multipart upload.
   *
   * S3 answers 411 Length Required to a chunked PUT, so a stream whose size is
   * not known up front cannot go in one request. Multipart is the way round it:
   * every part carries its own Content-Length, and only one part is ever held
   * in memory.
   *
   * The part buffer is allocated once and refilled, because a fresh allocation
   * per part makes peak memory climb with file size even though only one part
   * is live. Reuse is safe: each part is fully awaited before the buffer is
   * written again.
   */
  public async putObjectStreaming(
    key: string,
    source: AsyncIterable<Uint8Array>,
    mimeType?: string,
    metadata?: Record<string, string>,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{ size: number; etag?: string }> {
    const uploadId = await this.createMultipartUpload(key, mimeType, metadata);
    const parts: S3UploadPart[] = [];
    const buffer = new Uint8Array(MULTIPART_PART_SIZE);

    let filled = 0;
    let total = 0;
    let partNumber = 1;

    const flush = async (length: number): Promise<void> => {
      parts.push(await this.uploadPart(key, uploadId, partNumber, buffer.subarray(0, length)));
      partNumber += 1;
      total += length;
      onProgress?.({ bytesUploaded: total, totalBytes: undefined, percentage: undefined });
    };

    try {
      for await (const chunk of source) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const take = Math.min(MULTIPART_PART_SIZE - filled, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;

          if (filled === MULTIPART_PART_SIZE) {
            await flush(filled);
            filled = 0;
          }
        }
      }

      // The final part may be short. An empty stream still needs one part:
      // S3 rejects a zero-part upload.
      if (filled > 0 || parts.length === 0) {
        await flush(filled);
      }

      const completed = await this.completeMultipartUpload(key, uploadId, parts);
      return { size: total, etag: completed.checksum };
    } catch (error) {
      // Discard the pending parts so they stop accruing storage charges. The
      // original failure is what the caller needs, not an abort failure.
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  public async createMultipartUpload(
    key: string,
    mimeType?: string,
    metadata?: Record<string, string>
  ): Promise<string> {
    const url = new URL(this.getObjectUrl(key));
    url.searchParams.set("uploads", "");

    // User metadata is only accepted when the upload is created, not on the
    // individual parts, so it has to be attached here or it is lost.
    const headers: Record<string, string> = {
      "content-type": mimeType || "application/octet-stream"
    };
    for (const [name, value] of Object.entries(metadata ?? {})) {
      headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    }

    const signedHeaders = signS3Request(this.config, {
      method: "POST",
      url: url.toString(),
      headers
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
