import { withRetry, type StorageInput, type UploadProgress } from "@byoc/core";
import { GoogleOAuthClient } from "../auth/oauth-client.js";
import { mapGoogleDriveError } from "../errors/mapper.js";
import { storageInputToUint8Array } from "./multipart.js";
import type { DriveFileResource } from "./types.js";

const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_DRIVE_CHUNK_ALIGNMENT = 256 * 1024; // 256 KiB
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB (4 * 256 KiB)

export interface ResumableUploadOptions {
  mimeType?: string;
  chunkSize?: number;
  onProgress?: (progress: UploadProgress) => void;
}

/**
 * ResumableUploader — Implements Google Drive's chunked resumable upload protocol
 * with progress events and network disconnection resumption.
 */
export class ResumableUploader {
  constructor(private readonly oauth: GoogleOAuthClient) {}

  /**
   * Uploads large binary data in chunks using the Google Drive Resumable Upload protocol.
   */
  public async upload(
    metadata: { name: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string> },
    data: StorageInput,
    options: ResumableUploadOptions = {}
  ): Promise<DriveFileResource> {
    const bytes = await storageInputToUint8Array(data);
    const totalBytes = bytes.byteLength;
    const mimeType = options.mimeType || metadata.mimeType || "application/octet-stream";

    // Align chunk size to 256 KiB boundary
    const rawChunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkSize = Math.max(
      GOOGLE_DRIVE_CHUNK_ALIGNMENT,
      Math.floor(rawChunkSize / GOOGLE_DRIVE_CHUNK_ALIGNMENT) * GOOGLE_DRIVE_CHUNK_ALIGNMENT
    );

    // 1. Initiate Resumable Upload Session
    const sessionUri = await this.initiateSession(metadata, totalBytes, mimeType);

    // 2. Transmit Chunks
    return this.transmitChunks(sessionUri, bytes, totalBytes, chunkSize, mimeType, options.onProgress);
  }

  /**
   * Streams an async iterator into a resumable session without buffering it.
   *
   * Drive accepts `Content-Range: bytes {start}-{end}/*` while the total is
   * still unknown, and requires the real total on the final chunk. That forces
   * a one-chunk lookahead: a chunk cannot be sent as non-final until we know
   * more data follows, and cannot be sent as final until we know none does.
   * Two buffers alternate so the reader always has somewhere to write while a
   * full chunk waits to be classified.
   *
   * Memory is therefore bounded at two chunks, not at the object size.
   */
  public async uploadStream(
    metadata: Record<string, unknown>,
    source: AsyncIterable<Uint8Array>,
    mimeType: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<DriveFileResource> {
    const aligned = Math.max(
      GOOGLE_DRIVE_CHUNK_ALIGNMENT,
      Math.floor(chunkSize / GOOGLE_DRIVE_CHUNK_ALIGNMENT) * GOOGLE_DRIVE_CHUNK_ALIGNMENT
    );
    const sessionUri = await this.initiateSession(metadata, 0, mimeType, true);

    const buffers = [new Uint8Array(aligned), new Uint8Array(aligned)];
    let current = 0;
    let filled = 0;
    let held: number | null = null;
    let offset = 0;
    let finalResource: DriveFileResource | undefined;

    const send = async (
      index: number,
      length: number,
      total: number | null
    ): Promise<void> => {
      if (length === 0 && total === null) return;

      const marker = total === null ? "*" : String(total);
      const range =
        length === 0
          ? `bytes */${total}`
          : `bytes ${offset}-${offset + length - 1}/${marker}`;

      const accessToken = await this.oauth.getAccessToken();
      const response = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Range": range
        },
        body: buffers[index]!.subarray(0, length)
      });

      if (response.status === 200 || response.status === 201) {
        offset += length;
        finalResource = (await response.json()) as DriveFileResource;
        onProgress?.({ bytesUploaded: offset, totalBytes: offset, percentage: 100 });
        return;
      }

      if (response.status !== 308) {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          data = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data });
      }

      // Trust the server's committed range over our own bookkeeping.
      const committed = response.headers.get("Range");
      offset = committed ? Number(committed.split("-").pop()) + 1 : offset + length;
      onProgress?.({ bytesUploaded: offset, totalBytes: undefined, percentage: undefined });
    };

    for await (const chunk of source) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      let position = 0;
      while (position < bytes.byteLength) {
        const take = Math.min(aligned - filled, bytes.byteLength - position);
        buffers[current]!.set(bytes.subarray(position, position + take), filled);
        filled += take;
        position += take;

        if (filled === aligned) {
          // A full buffer cannot be final while more data may follow, so
          // release the previously held one and hold this instead.
          if (held !== null) await send(held, aligned, null);
          held = current;
          current = 1 - current;
          filled = 0;
        }
      }
    }

    // The stream is exhausted, so whatever remains is genuinely final.
    if (held !== null && filled === 0) {
      await send(held, aligned, offset + aligned);
    } else if (held !== null) {
      await send(held, aligned, null);
      await send(current, filled, offset + filled);
    } else {
      await send(current, filled, filled);
    }

    if (!finalResource) {
      throw mapGoogleDriveError({
        status: 500,
        data: {
          error: {
            message:
              "Google Drive accepted every chunk but never returned the file resource."
          }
        }
      });
    }
    return finalResource;
  }

  /**
   * Opens a resumable session without sending any bytes, and returns its URI.
   *
   * The session URI is a bearer capability: Drive accepts chunks at it with no
   * Authorization header, which is exactly what lets a browser upload straight
   * to the user's Drive while this server's OAuth token stays server-side.
   */
  public async createSession(
    metadata: Record<string, unknown>,
    totalBytes: number,
    mimeType: string
  ): Promise<string> {
    return this.initiateSession(metadata, totalBytes, mimeType);
  }

  /**
   * Initiates a resumable upload session and extracts the Location session URI.
   */
  private async initiateSession(
    metadata: Record<string, unknown>,
    totalBytes: number,
    mimeType: string,
    unknownLength = false
  ): Promise<string> {
    const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,appProperties`;

    return withRetry(async () => {
      const accessToken = await this.oauth.getAccessToken();

      const headers = new Headers({
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType
      });
      // Declaring a length we do not have would make Drive reject the final
      // chunk, so a stream simply omits the header.
      if (!unknownLength) {
        headers.set("X-Upload-Content-Length", String(totalBytes));
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(metadata)
      });

      if (!response.ok) {
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          errorData = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data: errorData });
      }

      const sessionUri = response.headers.get("Location");
      if (!sessionUri) {
        throw mapGoogleDriveError({
          status: 500,
          data: { error: { message: "Google Drive did not return a Location header for resumable upload." } }
        });
      }

      return sessionUri;
    });
  }

  /**
   * Transmits data chunks to the session URI until complete.
   */
  private async transmitChunks(
    sessionUri: string,
    bytes: Uint8Array,
    totalBytes: number,
    chunkSize: number,
    mimeType: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<DriveFileResource> {
    let offset = 0;

    // Handle empty 0-byte file edge case
    if (totalBytes === 0) {
      const response = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": "bytes */0"
        }
      });
      return (await response.json()) as DriveFileResource;
    }

    while (offset < totalBytes) {
      const chunkEnd = Math.min(offset + chunkSize, totalBytes);
      const chunk = bytes.subarray(offset, chunkEnd);
      const contentRange = `bytes ${offset}-${chunkEnd - 1}/${totalBytes}`;

      let chunkUploaded = false;
      let finalResource: DriveFileResource | undefined;

      await withRetry(async () => {
        const response = await fetch(sessionUri, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Range": contentRange
          },
          body: chunk as unknown as BodyInit
        });

        // 308 Resume Incomplete indicates chunk was saved successfully
        if (response.status === 308) {
          const rangeHeader = response.headers.get("Range");
          if (rangeHeader) {
            const match = rangeHeader.match(/bytes=0-(\d+)/);
            if (match && match[1]) {
              offset = Number(match[1]) + 1;
            } else {
              offset = chunkEnd;
            }
          } else {
            offset = chunkEnd;
          }
          chunkUploaded = true;
          return;
        }

        // 200 or 201 indicates entire file has been assembled and uploaded
        if (response.status === 200 || response.status === 201) {
          finalResource = (await response.json()) as DriveFileResource;
          offset = totalBytes;
          chunkUploaded = true;
          return;
        }

        // If error response, throw mapped error to trigger retry or failure
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          errorData = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data: errorData });
      }, {
        maxRetries: 3,
        baseDelayMs: 1000,
        shouldRetry: (_err) => true // Auto-recover on network interruption
      });

      if (chunkUploaded) {
        if (onProgress) {
          const percentage = Math.min(100, Math.round((offset / totalBytes) * 100));
          onProgress({
            bytesUploaded: offset,
            totalBytes,
            percentage
          });
        }
      }

      if (finalResource) {
        return finalResource;
      }
    }

    throw mapGoogleDriveError({
      status: 500,
      data: { error: { message: "Resumable upload loop terminated without receiving final completion resource." } }
    });
  }
}
