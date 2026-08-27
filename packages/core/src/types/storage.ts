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
