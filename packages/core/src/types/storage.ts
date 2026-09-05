import type { Readable } from "node:stream";

/**
 * Standard representation of a file or folder in any BYOC storage backend.
 */
export interface StorageObject {
  /** Unique universal identifier (e.g., virtual path or provider ID) */
  readonly id: string;
  /** Normalized virtual path relative to the app root (e.g., "users/123/avatar.jpg") */
  readonly path: string;
  /** Basename of the file or folder (e.g., "avatar.jpg") */
  readonly name: string;
  /** Provider identifier that owns this object (e.g., "google-drive", "cloudflare-r2") */
  readonly provider: string;
  /** Internal provider ID or key (opaque/private reference) */
  readonly providerId: string;

  readonly type?: "file" | "folder";
  readonly size?: number;
  readonly mimeType?: string;
  readonly checksum?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Supported binary input types for uploads.
 */
export type StorageInput =
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | Readable
  | ReadableStream
  | Blob
  | string;

/**
 * Standard download output from any provider.
 */
export interface StorageOutput {
  /** Readable binary stream of the content */
  readonly stream: Readable | ReadableStream;
  /** Utility to buffer the entire payload into a Node Buffer (when running in Node) */
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  /** Utility to read payload as text */
  readonly text: () => Promise<string>;
  /** Metadata of the downloaded object */
  readonly metadata: StorageObject;
}

/**
 * Progress event payload emitted during chunked/resumable uploads.
 */
export interface UploadProgress {
  readonly bytesUploaded: number;
  readonly totalBytes?: number;
  readonly percentage?: number;
}

/**
 * Configuration options for file uploads.
 */
export interface UploadOptions {
  readonly mimeType?: string;
  /** Exact byte length of the supplied input. Required for portable S3 streaming uploads. */
  readonly contentLength?: number;
  readonly resumable?: boolean;
  readonly chunkSize?: number;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Configuration options for automated database/data backups.
 */
export interface BackupOptions {
  readonly filename?: string;
  readonly folder?: string;
  readonly mimeType?: string;
  readonly onProgress?: (progress: UploadProgress) => void;
}

/**
 * Storage quota information reported by the cloud provider.
 */
export interface StorageQuota {
  /** Total storage capacity in bytes (if known) */
  readonly total?: number;
  /** Currently used storage in bytes */
  readonly used: number;
  /** Remaining available storage in bytes (if known) */
  readonly available?: number;
}

/** One path a batch operation could not complete, and why. */
export interface BatchFailure {
  readonly path: string;
  readonly error: string;
  readonly code: string;
}

/**
 * Outcome of a multi-path delete.
 *
 * A batch is reported rather than throwing on the first failure, because a
 * partial delete is the common real case: one object is locked or already
 * gone while the rest succeed, and the caller needs to know which.
 */
export interface BatchDeleteReport {
  readonly deleted: string[];
  readonly failed: BatchFailure[];
  readonly total: number;
  readonly allSucceeded: boolean;
}

/** Options for a time-limited signed URL. */
export interface SignedUrlOptions {
  readonly method?: string;
  readonly expiresInSeconds?: number;
}

/**
 * A capability to upload one object, safe to hand to an untrusted client.
 *
 * The whole point of BYOC is that file bytes never pass through the
 * application server. A grant is what makes that literal: the server signs or
 * opens an upload, hands the browser this object, and the browser transfers
 * the bytes straight to the user's own cloud.
 *
 * It is deliberately a plain data object -- JSON-serializable, no methods, no
 * credentials of the application's own -- so it can be returned from an API
 * route and consumed by `@byoc/browser`.
 *
 * Providers reach the same shape by different routes: S3 signs a PUT URL,
 * Google Drive opens a resumable session whose URI is itself the capability.
 * Neither requires the client to hold a long-lived secret.
 */
export interface UploadGrant {
  /** Provider that issued it, so the client can pick the right transfer path. */
  readonly provider: string;
  /** Virtual path the bytes will land at. */
  readonly path: string;
  /** Absolute URL the client uploads to. Treat as a secret: it IS the capability. */
  readonly url: string;
  /** HTTP method the client must use. */
  readonly method: "PUT" | "POST";
  /**
   * Headers the client must send verbatim. For a signed URL this is usually
   * empty, because signing extra headers would force the browser to reproduce
   * them exactly.
   */
  readonly headers: Record<string, string>;
  /**
   * "single" sends the whole body in one request. "resumable" allows chunked
   * transfer with Content-Range, and survives a dropped connection.
   */
  readonly protocol: "single" | "resumable";
  /** After this instant the grant is refused by the provider. */
  readonly expiresAt: Date;
  /** Chunk size in bytes for resumable transfers, when the provider requires alignment. */
  readonly chunkSize?: number;
  /** Provider-declared upper bound on the payload, when one applies. */
  readonly maxBytes?: number;
}

/** Options when minting an {@link UploadGrant}. */
export interface UploadGrantOptions {
  /** Seconds until the grant expires. Keep it short; it is a bearer capability. */
  readonly expiresInSeconds?: number;
  /** Content type recorded on the stored object. */
  readonly mimeType?: string;
  /** Total size, when known. Some providers require it up front. */
  readonly sizeBytes?: number;
}
