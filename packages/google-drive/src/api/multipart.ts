import type { StorageInput } from "@byoc/core";
import { Readable } from "node:stream";

/**
 * Converts any supported StorageInput into a Uint8Array.
 */
export async function storageInputToUint8Array(input: StorageInput): Promise<Uint8Array> {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
  if (input instanceof Readable || (typeof ReadableStream !== "undefined" && input instanceof ReadableStream)) {
    const chunks: Uint8Array[] = [];
    if (input instanceof Readable) {
      for await (const chunk of input) {
        if (typeof chunk === "string") {
          chunks.push(new TextEncoder().encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          chunks.push(chunk);
        } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) {
          chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
      }
    } else {
      const reader = (input as ReadableStream).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  throw new Error("Unsupported storage input type.");
}

export interface MultipartUploadPayload {
  body: Uint8Array;
  contentType: string;
}

/**
 * Builds a multipart/related body containing JSON metadata and binary data.
 */
export async function buildMultipartBody(
  metadata: Record<string, unknown>,
  data: StorageInput,
  mimeType: string = "application/octet-stream"
): Promise<MultipartUploadPayload> {
  const boundary = `-------BYOC_BOUNDARY_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataJson = JSON.stringify(metadata);
  const metadataHeader =
    delimiter +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadataJson +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const headerBytes = new TextEncoder().encode(metadataHeader);
  const fileBytes = await storageInputToUint8Array(data);
  const footerBytes = new TextEncoder().encode(closeDelimiter);

  const totalLength = headerBytes.byteLength + fileBytes.byteLength + footerBytes.byteLength;
  const combined = new Uint8Array(totalLength);

  combined.set(headerBytes, 0);
  combined.set(fileBytes, headerBytes.byteLength);
  combined.set(footerBytes, headerBytes.byteLength + fileBytes.byteLength);

  return {
    body: combined,
    contentType: `multipart/related; boundary=${boundary}`
  };
}
