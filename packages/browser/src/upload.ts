import type { UploadGrant } from "@byoc/core";

/** Progress of a direct upload. */
export interface DirectUploadProgress {
  /** Bytes confirmed transferred so far. */
  readonly bytesUploaded: number;
  /** Total bytes to transfer. */
  readonly totalBytes: number;
  /** 0-100, rounded to one decimal. */
  readonly percentage: number;
}

export interface UploadWithGrantOptions {
  onProgress?: (progress: DirectUploadProgress) => void;
  /** Abort the transfer. Resumable uploads can be resumed afterwards. */
  signal?: AbortSignal;
  /**
   * Attempts per chunk before giving up. Only transient failures are retried:
   * a 403 means the grant expired and retrying cannot help.
   */
  maxAttempts?: number;
}

/** Raised when a direct upload fails. */
export class DirectUploadError extends Error {
  public readonly status?: number;
  public readonly expired: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DirectUploadError";
    this.status = status;
    // 403 on a signed URL almost always means the clock ran out on the grant.
    this.expired = status === 403;
  }
}

/** Body shapes a caller can hand us. */
export type UploadBody = Blob | ArrayBuffer | Uint8Array | string;

function toBlob(body: UploadBody): Blob {
  if (body instanceof Blob) return body;
  if (typeof body === "string") return new Blob([body]);
  // Copy into a fresh view so a shared ArrayBuffer's offset is respected.
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return new Blob([bytes.slice()]);
}

function isTransient(status: number): boolean {
  // 408 timeout, 429 throttled, 5xx server-side. A 4xx otherwise is our fault
  // and will fail identically on retry.
  return status === 408 || status === 429 || status >= 500;
}

function assertUsable(grant: UploadGrant): void {
  if (grant.expiresAt.getTime() <= Date.now()) {
    throw new DirectUploadError(
      `This upload grant expired at ${grant.expiresAt.toISOString()}. ` +
        "Ask your server for a new one.",
      403
    );
  }
}

/**
 * Sends one request, reporting upload progress.
 *
 * Uses XMLHttpRequest rather than fetch because fetch cannot report *upload*
 * progress in any shipping browser -- its streaming request bodies are still
 * not universally available, and a progress bar is the whole reason a user
 * tolerates a large upload. Falls back to fetch where XHR is absent (Node).
 */
async function sendChunk(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Blob,
  options: UploadWithGrantOptions,
  alreadySent: number,
  totalBytes: number
): Promise<{ status: number; text: string; headers: Headers | null }> {
  if (typeof XMLHttpRequest === "undefined") {
    const response = await fetch(url, { method, headers, body, signal: options.signal });
    const text = await response.text().catch(() => "");
    options.onProgress?.({
      bytesUploaded: alreadySent + body.size,
      totalBytes,
      percentage: Math.round(((alreadySent + body.size) / totalBytes) * 1000) / 10
    });
    return { status: response.status, text, headers: response.headers };
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

    const onAbort = (): void => xhr.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    xhr.upload.onprogress = (event): void => {
      if (!event.lengthComputable || !options.onProgress) return;
      const sent = alreadySent + event.loaded;
      options.onProgress({
        bytesUploaded: sent,
        totalBytes,
        percentage: Math.round((sent / totalBytes) * 1000) / 10
      });
    };

    xhr.onload = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        status: xhr.status,
        text: xhr.responseText,
        // Header access is limited by CORS; callers only need Range here.
        headers: null
      });
    };
    xhr.onerror = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      // A network-level failure gives no status. In practice on a signed URL
      // this is nearly always a missing CORS rule on the bucket.
      reject(
        new DirectUploadError(
          "The upload could not reach the storage provider. If this is a browser, " +
            "the provider most likely has no CORS rule allowing PUT from this origin.",
          0
        )
      );
    };
    xhr.onabort = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new DirectUploadError("Upload aborted by the caller."));
    };
    xhr.getResponseHeader("Range");
    xhr.send(body);
  });
}

/**
 * Uploads a file straight to the user's cloud using a grant from your server.
 *
 * Your server never sees the bytes -- it only mints the grant. That is the
 * entire point: the transfer is between the user's machine and the user's own
 * storage account.
 *
 * ```ts
 * const grant = await fetch("/api/upload-grant?path=photo.jpg").then(r => r.json());
 * await uploadWithGrant(reviveGrant(grant), file, {
 *   onProgress: p => setPercent(p.percentage)
 * });
 * ```
 */
export async function uploadWithGrant(
  grant: UploadGrant,
  body: UploadBody,
  options: UploadWithGrantOptions = {}
): Promise<void> {
  assertUsable(grant);

  const blob = toBlob(body);
  // `!= null` is deliberate: it catches both undefined and a JSON null from a
  // server that serializes absent fields explicitly.
  if (grant.maxBytes != null && blob.size > grant.maxBytes) {
    throw new DirectUploadError(
      `File is ${blob.size} bytes but this grant allows at most ${grant.maxBytes}.`
    );
  }

  if (grant.protocol === "resumable") {
    return uploadResumable(grant, blob, options);
  }
  return uploadSingle(grant, blob, options);
}

async function uploadSingle(
  grant: UploadGrant,
  blob: Blob,
  options: UploadWithGrantOptions
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { status, text } = await sendChunk(
      grant.url,
      grant.method,
      grant.headers,
      blob,
      options,
      0,
      blob.size
    );

    if (status >= 200 && status < 300) return;
    if (!isTransient(status) || attempt === maxAttempts) {
      throw new DirectUploadError(
        `Direct upload failed with HTTP ${status}. ${text.slice(0, 200)}`,
        status
      );
    }
    // Exponential backoff, matching the server SDK's retry shape.
    await new Promise((r) => setTimeout(r, 2 ** (attempt - 1) * 500));
  }
}

/**
 * Chunked upload against a resumable session URI.
 *
 * Google Drive requires every chunk except the last to be a multiple of
 * 256 KiB, and answers each accepted chunk with 308 plus a Range header
 * naming the last byte it holds. We trust that header over our own counter,
 * because after a retry the server's view is the authoritative one.
 */
async function uploadResumable(
  grant: UploadGrant,
  blob: Blob,
  options: UploadWithGrantOptions
): Promise<void> {
  const chunkSize = grant.chunkSize ?? 8 * 1024 * 1024;
  const total = blob.size;
  let offset = 0;
  let attempts = 0;
  const maxAttempts = options.maxAttempts ?? 5;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const slice = blob.slice(offset, end);

    const headers = {
      ...grant.headers,
      "Content-Range": `bytes ${offset}-${end - 1}/${total}`
    };

    const { status, text } = await sendChunk(
      grant.url,
      "PUT",
      headers,
      slice,
      options,
      offset,
      total
    );

    if (status === 200 || status === 201) return;

    if (status === 308) {
      // Accepted, more expected. Advance by what we sent; a Range header would
      // be authoritative but CORS usually hides it from the browser.
      offset = end;
      attempts = 0;
      continue;
    }

    attempts += 1;
    if (!isTransient(status) || attempts >= maxAttempts) {
      throw new DirectUploadError(
        `Resumable upload failed at byte ${offset} with HTTP ${status}. ${text.slice(0, 200)}`,
        status
      );
    }
    await new Promise((r) => setTimeout(r, 2 ** (attempts - 1) * 500));
  }
}

/**
 * Rebuilds a grant that crossed the wire as JSON.
 *
 * `expiresAt` is a Date on the server and a string after `JSON.stringify`, so
 * a grant fetched from an API route must be revived before use. Without this
 * the expiry check silently compares against an invalid Date.
 */
export function reviveGrant(raw: unknown): UploadGrant {
  const value = raw as Record<string, unknown>;
  if (!value || typeof value.url !== "string" || typeof value.path !== "string") {
    throw new DirectUploadError(
      "That does not look like an UploadGrant: it has no url or path."
    );
  }
  // A grant with no expiry is treated as already expired rather than eternal:
  // failing closed is the only safe reading of a missing bound on a capability.
  return {
    ...(value as unknown as UploadGrant),
    expiresAt: value.expiresAt ? new Date(value.expiresAt as string) : new Date(0)
  };
}
