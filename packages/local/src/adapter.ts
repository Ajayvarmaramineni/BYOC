import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";

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

export const PROVIDER_ID = "local";

/**
 * Sidecar metadata lives under a single dotted directory at the root, so a
 * caller's own files are never shadowed and listings stay clean.
 */
const SIDECAR_DIR = ".byoc";

export interface LocalFileSystemProviderConfig {
  /** Directory that backs this provider. Created on connect unless disabled. */
  rootDirectory: string;
  /** Set `false` to require the directory to already exist. */
  createRoot?: boolean;
}

interface Sidecar {
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Stores objects as real files under `rootDirectory`.
 *
 * The provider that needs no account, no network, and no credentials. It
 * exists so BYOC can be evaluated, tested, and developed against before
 * anyone signs up for anything, and so a self-hosted deployment can use a
 * mounted volume as first-class storage rather than a special case.
 *
 * Every path is confined to `rootDirectory`: paths are resolved before use
 * and rechecked afterwards, so neither `..` nor a symlink can escape.
 */
export class LocalFileSystemProvider implements BYOCProvider {
  private readonly configuredRoot: string;
  private readonly createRoot: boolean;
  private resolvedRoot?: string;

  constructor(config: LocalFileSystemProviderConfig) {
    this.configuredRoot = path.resolve(config.rootDirectory);
    this.createRoot = config.createRoot ?? true;
  }

  public manifest(): ProviderManifest {
    return {
      id: PROVIDER_ID,
      name: "Local Filesystem",
      category: "self-hosted",
      authentication: "local",
      supportsUserOwnedStorage: true,
      adapterVersion: "0.3.0"
    };
  }

  public capabilities(): ProviderCapabilities {
    // No sharing and no public URLs: a local path is not reachable by a
    // browser, and pretending otherwise would break feature detection.
    return {
      folders: true,
      sharing: false,
      publicUrls: false,
      resumableUploads: false,
      versioning: false,
      quota: true,
      serverSideCopy: true
    };
  }

  public async connect(): Promise<void> {
    if (this.createRoot) {
      await fs.mkdir(this.configuredRoot, { recursive: true });
    } else {
      const stat = await fs.stat(this.configuredRoot).catch(() => undefined);
      if (!stat?.isDirectory()) {
        throw new StorageError({
          code: BYOCErrorCode.INVALID_INPUT,
          message: `Local storage root does not exist: ${this.configuredRoot}`,
          provider: PROVIDER_ID,
          retryable: false
        });
      }
    }
    this.resolvedRoot = await fs.realpath(this.configuredRoot);
  }

  public async disconnect(): Promise<void> {
    // Nothing to release: there is no connection and no cached handle.
    this.resolvedRoot = undefined;
  }

  // -- path handling ------------------------------------------------------

  private root(): string {
    // Resolve lazily so a caller who forgets connect() still gets correct
    // behaviour rather than a confusing undefined.
    return this.resolvedRoot ?? this.configuredRoot;
  }

  /**
   * Virtual path -> absolute filesystem path, confined to the root.
   *
   * `normalizeVirtualPath` already rejects `..`. This adds the check that
   * survives symlinks, which traversal filtering alone cannot catch: the
   * resolved target must still sit inside the resolved root.
   */
  private async toLocal(virtualPath: string): Promise<string> {
    const normalized = normalizeVirtualPath(virtualPath);
    const root = this.root();
    const candidate = normalized ? path.join(root, normalized) : root;

    // realpath the deepest existing ancestor, so this works for paths being
    // created as well as existing ones while still following symlinks.
    let existing = candidate;
    const trailing: string[] = [];
    for (;;) {
      const found = await fs
        .access(existing, fsConstants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (found) break;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      trailing.unshift(path.basename(existing));
      existing = parent;
    }

    const realExisting = await fs.realpath(existing).catch(() => existing);
    const resolved = trailing.length ? path.join(realExisting, ...trailing) : realExisting;

    const relative = path.relative(root, resolved);
    const escapes = relative.startsWith("..") || path.isAbsolute(relative);
    if (resolved !== root && escapes) {
      throw new StorageError({
        code: BYOCErrorCode.PERMISSION_DENIED,
        message: `Path "${virtualPath}" resolves outside the storage root.`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    return resolved;
  }

  // -- sidecar metadata ---------------------------------------------------

  private sidecarFor(normalized: string): string {
    return path.join(this.root(), SIDECAR_DIR, `${normalized}.json`);
  }

  private async readSidecar(normalized: string): Promise<Sidecar> {
    try {
      return JSON.parse(await fs.readFile(this.sidecarFor(normalized), "utf-8")) as Sidecar;
    } catch {
      // A missing or unreadable sidecar is not an error: the file itself is
      // the source of truth, and metadata is supplementary.
      return {};
    }
  }

  private async writeSidecar(normalized: string, sidecar: Sidecar): Promise<void> {
    if (!sidecar.mimeType && !sidecar.metadata) return;
    const target = this.sidecarFor(normalized);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(sidecar), "utf-8");
  }

  // -- object construction ------------------------------------------------

  private async toObject(localPath: string, normalized: string): Promise<StorageObject> {
    const stat = await fs.stat(localPath);
    const isDir = stat.isDirectory();
    const sidecar = isDir ? {} : await this.readSidecar(normalized);

    return {
      id: `local_${normalized}`,
      path: normalized,
      name: getBasename(normalized) || path.basename(localPath),
      provider: PROVIDER_ID,
      providerId: localPath,
      type: isDir ? "folder" : "file",
      size: isDir ? undefined : stat.size,
      mimeType: isDir ? undefined : (sidecar.mimeType ?? "application/octet-stream"),
      createdAt: stat.birthtime,
      updatedAt: stat.mtime,
      metadata: sidecar.metadata
    };
  }

  private static mapError(error: unknown, target: string): StorageError {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: `Local file not found: ${target}`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    if (code === "EACCES" || code === "EPERM" || code === "EISDIR") {
      return new StorageError({
        code: BYOCErrorCode.PERMISSION_DENIED,
        message: `Local filesystem refused the operation on ${target} (${code}).`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    return new StorageError({
      code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
      message: `Local filesystem error on ${target}: ${String(error)}`,
      provider: PROVIDER_ID,
      retryable: false
    });
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
    } else if (typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of data as AsyncIterable<Uint8Array | string>) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
    } else {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Unsupported upload payload type for the local provider.",
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
    virtualPath: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(virtualPath);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Upload requires a file path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }

    const target = await this.toLocal(normalized);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });

      let written: number;
      if (
        typeof data !== "string" &&
        !(data instanceof Uint8Array) &&
        !(data instanceof ArrayBuffer) &&
        (data instanceof Readable ||
          typeof (data as ReadableStream).getReader === "function" ||
          typeof (data as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function")
      ) {
        // Pipe streams straight to disk rather than buffering them first.
        written = await this.writeStream(target, data);
      } else {
        const payload = await LocalFileSystemProvider.toBytes(data);
        await fs.writeFile(target, payload);
        written = payload.byteLength;
      }

      await this.writeSidecar(normalized, {
        mimeType: options?.mimeType,
        metadata: options?.metadata
      });

      options?.onProgress?.({
        bytesUploaded: written,
        totalBytes: written,
        percentage: 100
      });
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, normalized);
    }

    return this.toObject(target, normalized);
  }

  private async writeStream(target: string, data: StorageInput): Promise<number> {
    const handle = await fs.open(target, "w");
    let written = 0;
    try {
      const source =
        data instanceof Readable
          ? data
          : typeof (data as ReadableStream).getReader === "function"
            ? Readable.fromWeb(data as never)
            : Readable.from(data as unknown as AsyncIterable<Uint8Array>);

      for await (const chunk of source) {
        const bytes =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
        await handle.write(bytes);
        written += bytes.byteLength;
      }
    } finally {
      await handle.close();
    }
    return written;
  }

  public async download(virtualPath: string): Promise<StorageOutput> {
    const normalized = normalizeVirtualPath(virtualPath);
    const target = await this.toLocal(normalized);

    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat?.isFile()) {
      throw new StorageError({
        code: BYOCErrorCode.OBJECT_NOT_FOUND,
        message: `Local file not found: ${normalized}`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }

    const metadata = await this.toObject(target, normalized);
    return {
      stream: createReadStream(target),
      arrayBuffer: async () => {
        const buffer = await fs.readFile(target);
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
      },
      text: () => fs.readFile(target, "utf-8"),
      metadata
    };
  }

  public async delete(virtualPath: string): Promise<void> {
    const normalized = normalizeVirtualPath(virtualPath);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Delete requires a path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    const target = await this.toLocal(normalized);
    // Deletion is idempotent, matching every other adapter.
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(this.sidecarFor(normalized), { force: true });
  }

  public async exists(virtualPath: string): Promise<boolean> {
    const normalized = normalizeVirtualPath(virtualPath);
    if (!normalized) return false;
    const target = await this.toLocal(normalized);
    return fs
      .access(target, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  public async metadata(virtualPath: string): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(virtualPath);
    const target = await this.toLocal(normalized);
    try {
      return await this.toObject(target, normalized);
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, normalized);
    }
  }

  public async list(virtualPath?: string): Promise<StorageObject[]> {
    const normalized = normalizeVirtualPath(virtualPath ?? "");
    const target = await this.toLocal(normalized);

    let entries: string[];
    try {
      entries = await fs.readdir(target);
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, normalized);
    }

    const results: StorageObject[] = [];
    for (const entry of entries.sort()) {
      // The sidecar store is an implementation detail, not content.
      if (entry === SIDECAR_DIR && target === this.root()) continue;
      const child = normalized ? `${normalized}/${entry}` : entry;
      results.push(await this.toObject(path.join(target, entry), child));
    }
    return results;
  }

  // -- capability-gated operations ----------------------------------------

  public async createFolder(virtualPath: string): Promise<StorageObject> {
    const normalized = normalizeVirtualPath(virtualPath);
    if (!normalized) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Create folder requires a path.",
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    const target = await this.toLocal(normalized);
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, normalized);
    }
    return this.toObject(target, normalized);
  }

  public async copy(source: string, destination: string): Promise<void> {
    const [sourceNorm, destNorm] = LocalFileSystemProvider.requirePair(source, destination, "Copy");
    const src = await this.toLocal(sourceNorm);
    const dst = await this.toLocal(destNorm);

    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.cp(src, dst, { recursive: true });
      const sidecar = await this.readSidecar(sourceNorm);
      await this.writeSidecar(destNorm, sidecar);
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, sourceNorm);
    }
  }

  public async move(source: string, destination: string): Promise<void> {
    const [sourceNorm, destNorm] = LocalFileSystemProvider.requirePair(source, destination, "Move");
    const src = await this.toLocal(sourceNorm);
    const dst = await this.toLocal(destNorm);

    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      const sidecar = await this.readSidecar(sourceNorm);
      await this.writeSidecar(destNorm, sidecar);
      await fs.rm(this.sidecarFor(sourceNorm), { force: true });
    } catch (error) {
      throw LocalFileSystemProvider.mapError(error, sourceNorm);
    }
  }

  private static requirePair(
    source: string,
    destination: string,
    operation: string
  ): [string, string] {
    const sourceNorm = normalizeVirtualPath(source);
    const destNorm = normalizeVirtualPath(destination);
    if (!sourceNorm || !destNorm) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `${operation} requires both a source and a destination path.`,
        provider: PROVIDER_ID,
        retryable: false
      });
    }
    return [sourceNorm, destNorm];
  }

  /** Reports the backing filesystem's usage, not this directory's. */
  public async quota(): Promise<StorageQuota> {
    const stat = await fs.statfs(this.root());
    const total = stat.blocks * stat.bsize;
    const available = stat.bavail * stat.bsize;
    return { used: total - stat.bfree * stat.bsize, total, available };
  }
}
