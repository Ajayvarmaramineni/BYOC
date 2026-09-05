import {
  BYOCErrorCode,
  StorageError,
  getBasename,
  normalizeVirtualPath,
  type BYOCProvider,
  type ProviderCapabilities,
  type ProviderManifest,
  type StorageInput,
  type StorageObject,
  type StorageOutput,
  type StorageQuota,
  type UploadOptions
} from "@byoc/core";

export const PROVIDER_ID = "memory";

const DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024;

/** One object's bytes plus the metadata a real provider would return. */
interface StoredObject {
  data: Uint8Array;
  mimeType: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface MemoryProviderConfig {
  /** Total capacity to report. Omit to report usage only. */
  quotaBytes?: number;
  /**
   * Bytes per chunk yielded by `download().stream`. Small values are useful
   * for exercising a caller's chunk handling.
   */
  streamChunkSize?: number;
}

/**
 * Keeps every object in a Map.
 *
 * A test double that behaves like a real provider: use it to unit-test code
 * that talks to BYOC without a disk, a network, or a credential, and to run
 * the same suite in CI that you run against a live backend.
 *
 * It models a flat key-value object store, the shape S3 and R2 have, so code
 * verified against it behaves the same way against those. Like S3 it has no
 * real folders, so it reports `folders: false` and offers no `createFolder`.
 * Paths still nest: `list("reports")` returns everything one level under
 * `reports/`.
 *
 * Nothing is persisted; every instance starts empty.
 */
export class MemoryProvider implements BYOCProvider {
  private readonly objects = new Map<string, StoredObject>();
  private readonly quotaBytes?: number;
  private readonly streamChunkSize: number;

  constructor(config: MemoryProviderConfig = {}) {
    if (config.streamChunkSize !== undefined && config.streamChunkSize < 1) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "streamChunkSize must be at least 1 byte.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    this.quotaBytes = config.quotaBytes;
    this.streamChunkSize = config.streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  }

  public manifest(): ProviderManifest {
    return {
      id: PROVIDER_ID,
      name: "In-Memory",
      category: "self-hosted",
      authentication: "local",
      supportsUserOwnedStorage: false,
      adapterVersion: "0.4.0"
    };
  }

  public capabilities(): ProviderCapabilities {
    return {
      folders: false,
      sharing: false,
      publicUrls: false,
      resumableUploads: false,
      versioning: false,
      quota: true,
      serverSideCopy: true,
      // Nothing is served over HTTP.
      directUpload: false
    };
  }

  public async connect(): Promise<void> {
    // Nothing to connect to.
  }

  public async disconnect(): Promise<void> {
    // Stored objects survive, so a reconnect sees the same state.
  }

  // -- test helpers -------------------------------------------------------

  /** Drops every stored object. Convenient between test cases. */
  public clear(): void {
    this.objects.clear();
  }

  /** Every stored path and its bytes, for assertions in tests. */
  public snapshot(): Record<string, Uint8Array> {
    return Object.fromEntries(
      [...this.objects].map(([path, stored]) => [path, stored.data])
    );
  }

  /** How many objects are stored. */
  public get size(): number {
    return this.objects.size;
  }

  // -- internals ----------------------------------------------------------

  private toObject(path: string, stored: StoredObject): StorageObject {
    return {
      id: `memory_${path}`,
      path,
      name: getBasename(path),
      provider: PROVIDER_ID,
      providerId: path,
      type: "file",
      size: stored.data.byteLength,
      mimeType: stored.mimeType,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      metadata: stored.metadata
    };
  }

  private require(path: string, operation: string): [string, StoredObject] {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `${operation} requires a path.`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    const stored = this.objects.get(normalized);
    if (!stored) {
      throw new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: `Object not found in memory storage: ${normalized}`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    return [normalized, stored];
  }

  /** Collapses every accepted input shape to bytes. */
  private static async toBytes(data: StorageInput): Promise<Uint8Array> {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }

    const chunks: Uint8Array[] = [];
    if (typeof (data as ReadableStream).getReader === "function") {
      const reader = (data as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } else if (typeof (data as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of data as AsyncIterable<Uint8Array | string>) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
    } else {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Unsupported upload payload type for the in-memory provider.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }

  // -- core operations ----------------------------------------------------

  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Upload requires a file path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }

    const payload = await MemoryProvider.toBytes(data);
    const now = new Date();
    const previous = this.objects.get(normalized);

    const stored: StoredObject = {
      data: payload,
      mimeType: options?.mimeType ?? "application/octet-stream",
      // Overwriting keeps the original creation time, as object stores do.
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      metadata: { ...(options?.metadata ?? {}) }
    };
    this.objects.set(normalized, stored);

    options?.onProgress?.({
      bytesUploaded: payload.byteLength,
      totalBytes: payload.byteLength,
      percentage: 100
    });

    return this.toObject(normalized, stored);
  }

  public async download(path: string): Promise<StorageOutput> {
    const [normalized, stored] = this.require(path, "Download");
    const payload = stored.data;
    const chunkSize = this.streamChunkSize;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
          controller.enqueue(payload.subarray(offset, offset + chunkSize));
        }
        controller.close();
      }
    });

    return {
      stream,
      arrayBuffer: async () =>
        payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength
        ) as ArrayBuffer,
      text: async () => new TextDecoder().decode(payload),
      metadata: this.toObject(normalized, stored)
    };
  }

  public async delete(path: string): Promise<void> {
    const normalized = normalizeVirtualPath(path);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Delete requires a path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    // Idempotent, matching every other adapter.
    this.objects.delete(normalized);
  }

  public async exists(path: string): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    return Boolean(normalized) && this.objects.has(normalized);
  }

  public async metadata(path: string): Promise<StorageObject> {
    const [normalized, stored] = this.require(path, "Metadata lookup");
    return this.toObject(normalized, stored);
  }

  public async list(path?: string): Promise<StorageObject[]> {
    const prefix = normalizeVirtualPath(path ?? "");
    const scope = prefix ? `${prefix}/` : "";

    const results: StorageObject[] = [];
    const seenPrefixes = new Set<string>();

    for (const [storedPath, stored] of this.objects) {
      if (!storedPath.startsWith(scope)) continue;

      const remainder = storedPath.slice(scope.length);
      if (!remainder.includes("/")) {
        results.push(this.toObject(storedPath, stored));
        continue;
      }

      // Deeper keys surface as a synthetic folder for their first segment,
      // which is what S3 does with CommonPrefixes. Without it a caller walking
      // the tree cannot discover anything nested, and a recursive delete would
      // silently leave objects behind.
      const child = `${scope}${remainder.split("/")[0]}`;
      if (seenPrefixes.has(child)) continue;
      seenPrefixes.add(child);
      results.push({
        id: `memory_${child}`,
        path: child,
        name: getBasename(child),
        provider: PROVIDER_ID,
        providerId: child,
        type: "folder"
      });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  // -- capability-gated operations ----------------------------------------

  public async copy(source: string, destination: string): Promise<void> {
    const [, stored] = this.require(source, "Copy");
    const destNorm = normalizeVirtualPath(destination);
    if (!destNorm) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Copy requires a destination path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }

    const now = new Date();
    this.objects.set(destNorm, {
      data: stored.data,
      mimeType: stored.mimeType,
      createdAt: now,
      updatedAt: now,
      metadata: { ...stored.metadata }
    });
  }

  public async move(source: string, destination: string): Promise<void> {
    await this.copy(source, destination);
    await this.delete(source);
  }

  public async quota(): Promise<StorageQuota> {
    let used = 0;
    for (const stored of this.objects.values()) used += stored.data.byteLength;

    if (this.quotaBytes === undefined) return { used };
    return {
      used,
      total: this.quotaBytes,
      available: Math.max(this.quotaBytes - used, 0)
    };
  }
}
