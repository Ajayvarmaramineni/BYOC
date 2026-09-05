import crypto from "node:crypto";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { BYOCErrorCode } from "../errors/codes.js";
import { StorageError } from "../errors/storage-error.js";
import type {
  BYOCProvider,
  ProviderCapabilities,
  ProviderManifest
} from "../types/provider.js";
import type {
  StorageInput,
  StorageObject,
  StorageOutput,
  UploadOptions,
  BackupOptions,
  StorageQuota
} from "../types/storage.js";

const pbkdf2Async = promisify(crypto.pbkdf2);

export interface E2EEOptions {
  passphrase?: string;
  masterKey?: Buffer | Uint8Array;
  keyDerivationIterations?: number;
  /** Plaintext bytes authenticated independently in each V3 frame. */
  frameSize?: number;
}

const E2EE_MAGIC_HEADER_V1 = Buffer.from("BYOC_E2EE_V1"); // 12 bytes (legacy v0.1 format, 100k fixed iter)
const E2EE_MAGIC_HEADER_V2 = Buffer.from("BYOC_E2EE_V2"); // 12 bytes (v0.2 format, dynamic 4-byte iter)
export const E2EE_MAGIC_HEADER_V3 = Buffer.from("BYOC_E2EE_V3");
const ITER_LENGTH = 4; // 4-byte big-endian unsigned integer
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH_V1 = E2EE_MAGIC_HEADER_V1.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
const HEADER_LENGTH_V2 = E2EE_MAGIC_HEADER_V2.length + ITER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
const NONCE_BASE_LENGTH = 8;
const FRAME_LENGTH_FIELD = 4;
export const E2EE_V3_HEADER_LENGTH = 44;
export const E2EE_V3_DEFAULT_FRAME_SIZE = 256 * 1024;
export const E2EE_V3_MIN_FRAME_SIZE = 4 * 1024;
export const E2EE_V3_MAX_FRAME_SIZE = 8 * 1024 * 1024;

/**
 * Accepted bounds for the envelope-encoded PBKDF2 iteration count.
 *
 * The iteration count is read from untrusted storage before the GCM tag can be
 * verified, so it must be range-checked first: a hostile 4-byte edit would
 * otherwise turn a ~50 ms decrypt into minutes of PBKDF2 occupying a libuv
 * threadpool thread. The floor rejects envelopes whose key derivation is too
 * weak to trust; the ceiling caps the work an attacker can force.
 */
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 2_000_000;

/**
 * End-to-End Encryption (E2EE) Utility: Encrypts and decrypts binary payloads with AES-256-GCM.
 * Non-blocking asynchronous PBKDF2 with dynamic envelope-encoded iteration counts.
 */
export class E2EECrypto {
  private readonly masterKey: Buffer;
  private readonly iterations: number;
  private readonly frameSize: number;

  constructor(options: E2EEOptions) {
    if (!options.passphrase && !options.masterKey) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "E2EECrypto requires either a 'passphrase' or 'masterKey'.",
        provider: "core"
      });
    }

    this.iterations = options.keyDerivationIterations ?? 600000;
    this.frameSize = options.frameSize ?? E2EE_V3_DEFAULT_FRAME_SIZE;

    if (
      !Number.isInteger(this.iterations) ||
      this.iterations < MIN_ITERATIONS ||
      this.iterations > MAX_ITERATIONS
    ) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `E2EECrypto 'keyDerivationIterations' must be between ${MIN_ITERATIONS} and ${MAX_ITERATIONS} (received ${this.iterations}).`,
        provider: "core",
        retryable: false
      });
    }

    if (
      !Number.isInteger(this.frameSize) ||
      this.frameSize < E2EE_V3_MIN_FRAME_SIZE ||
      this.frameSize > E2EE_V3_MAX_FRAME_SIZE
    ) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `E2EECrypto 'frameSize' must be between ${E2EE_V3_MIN_FRAME_SIZE} and ${E2EE_V3_MAX_FRAME_SIZE} bytes (received ${this.frameSize}).`,
        provider: "core",
        retryable: false
      });
    }

    if (options.masterKey) {
      this.masterKey = Buffer.from(options.masterKey);
    } else {
      this.masterKey = Buffer.from(options.passphrase!, "utf8");
    }
  }

  /** Returns the exact V3 envelope size for a plaintext byte length. */
  public encryptedSize(plaintextSize: number): number {
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `E2EE plaintext size must be a non-negative safe integer (received ${plaintextSize}).`,
        provider: "core",
        retryable: false
      });
    }
    const frameCount = Math.max(1, Math.ceil(plaintextSize / this.frameSize));
    if (frameCount > 0x1_0000_0000) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "E2EE plaintext exceeds the V3 frame-counter capacity.",
        provider: "core",
        retryable: false
      });
    }
    const envelopeSize =
      E2EE_V3_HEADER_LENGTH + plaintextSize + frameCount * (FRAME_LENGTH_FIELD + TAG_LENGTH);
    if (!Number.isSafeInteger(envelopeSize)) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "E2EE envelope size exceeds JavaScript's safe integer range.",
        provider: "core",
        retryable: false
      });
    }
    return envelopeSize;
  }

  /**
   * Asynchronously derives a 256-bit AES key from passphrase and salt using PBKDF2.
   * Runs in the libuv threadpool to avoid blocking the event loop.
   */
  private async deriveKey(salt: Buffer, iterations: number): Promise<Buffer> {
    return pbkdf2Async(this.masterKey, salt, iterations, 32, "sha256");
  }

  /** Encrypts a buffered value into the framed V3 envelope. */
  public async encrypt(plaintext: Uint8Array | string): Promise<Uint8Array> {
    const source = [typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext)];
    return this.collect(this.encryptStream(source));
  }

  /**
   * Encrypts bytes incrementally. Memory use is bounded by one plaintext frame,
   * regardless of the total object size.
   */
  public async *encryptStream(
    source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>
  ): AsyncGenerator<Uint8Array> {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const nonceBase = crypto.randomBytes(NONCE_BASE_LENGTH);
    const iterBuf = Buffer.alloc(ITER_LENGTH);
    iterBuf.writeUInt32BE(this.iterations, 0);
    const frameSizeBuf = Buffer.alloc(FRAME_LENGTH_FIELD);
    frameSizeBuf.writeUInt32BE(this.frameSize, 0);
    const header = Buffer.concat([
      E2EE_MAGIC_HEADER_V3,
      iterBuf,
      frameSizeBuf,
      salt,
      nonceBase
    ]);
    const key = await this.deriveKey(salt, this.iterations);

    yield header;

    let index = 0;
    let pending: Buffer | undefined;
    for await (const frame of this.frameSource(source, this.frameSize)) {
      if (pending !== undefined) {
        yield this.encryptFrame(pending, index, false, key, nonceBase, header);
        index += 1;
      }
      pending = frame;
    }

    // A zero-byte file still needs one authenticated final frame.
    yield this.encryptFrame(pending ?? Buffer.alloc(0), index, true, key, nonceBase, header);
  }

  /** Decrypts V3 streams incrementally and keeps V1/V2 read compatibility. */
  public async *decryptStream(
    source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>
  ): AsyncGenerator<Uint8Array> {
    const reader = new AsyncByteReader(source);
    const magic = await reader.readExactly(E2EE_MAGIC_HEADER_V3.length);
    const isV3 = magic.equals(E2EE_MAGIC_HEADER_V3);

    if (!isV3) {
      const legacyEnvelope = Buffer.concat([magic, await reader.readRemaining()]);
      yield await this.decryptLegacy(legacyEnvelope);
      return;
    }

    const headerTail = await reader.readExactly(E2EE_V3_HEADER_LENGTH - magic.length);
    const header = Buffer.concat([magic, headerTail]);
    const iterations = header.readUInt32BE(12);
    const frameSize = header.readUInt32BE(16);

    this.validateIterations(iterations);
    if (frameSize < E2EE_V3_MIN_FRAME_SIZE || frameSize > E2EE_V3_MAX_FRAME_SIZE) {
      throw this.corrupted(
        `Invalid E2EE V3 payload: frame size ${frameSize} is outside the accepted range (${E2EE_V3_MIN_FRAME_SIZE}-${E2EE_V3_MAX_FRAME_SIZE}).`
      );
    }

    const salt = header.subarray(20, 36);
    const nonceBase = header.subarray(36, E2EE_V3_HEADER_LENGTH);
    const key = await this.deriveKey(salt, iterations);

    let lengthField = await reader.readExactly(FRAME_LENGTH_FIELD, true);
    if (lengthField === null) {
      throw this.corrupted("Invalid E2EE V3 payload: Missing authenticated final frame.");
    }

    let index = 0;
    let current = await this.readFrame(reader, lengthField, frameSize);
    for (;;) {
      const nextLength = await reader.readExactly(FRAME_LENGTH_FIELD, true);
      const isFinal = nextLength === null;
      yield this.decryptFrame(current, index, isFinal, key, nonceBase, header);

      if (isFinal) return;
      index += 1;
      current = await this.readFrame(reader, nextLength, frameSize);
    }
  }

  /** Transparently decrypts V1, V2, or V3 buffered envelopes. */
  public async decrypt(envelopeBytes: Uint8Array): Promise<Uint8Array> {
    return this.collect(this.decryptStream([envelopeBytes]));
  }

  private async decryptLegacy(buf: Buffer): Promise<Uint8Array> {

    if (buf.length < HEADER_LENGTH_V1) {
      throw this.corrupted("Invalid E2EE payload: Data is shorter than header size.");
    }

    const isV2 = buf.subarray(0, E2EE_MAGIC_HEADER_V2.length).equals(E2EE_MAGIC_HEADER_V2);
    const isV1 = buf.subarray(0, E2EE_MAGIC_HEADER_V1.length).equals(E2EE_MAGIC_HEADER_V1);

    if (!isV2 && !isV1) {
      throw this.corrupted("Invalid E2EE payload: Missing or unrecognized magic header.");
    }

    let offset = 12;
    let fileIterations: number;
    let aad: Buffer;

    if (isV2) {
      if (buf.length < HEADER_LENGTH_V2) {
        throw this.corrupted("Invalid E2EE V2 payload: Data is shorter than header size.");
      }

      const iterBuf = buf.subarray(offset, offset + ITER_LENGTH);
      fileIterations = iterBuf.readUInt32BE(0);

      // Range-check before deriving: this value comes from untrusted storage and
      // is consumed before the GCM tag can authenticate it.
      this.validateIterations(fileIterations);
      offset += ITER_LENGTH;

      const salt = buf.subarray(offset, offset + SALT_LENGTH);
      aad = Buffer.concat([E2EE_MAGIC_HEADER_V2, iterBuf, salt]);
    } else {
      // Legacy V1 format (fixed 100,000 iterations without explicit iter field)
      fileIterations = 100_000;
      const salt = buf.subarray(offset, offset + SALT_LENGTH);
      aad = Buffer.concat([E2EE_MAGIC_HEADER_V1, salt]);
    }

    const salt = buf.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = buf.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const tag = buf.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;
    const ciphertext = buf.subarray(offset);

    try {
      const derivedKey = await this.deriveKey(salt, fileIterations);
      const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);

      decipher.setAAD(aad);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return new Uint8Array(decrypted);
    } catch {
      throw new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "E2EE Decryption failed: Invalid passphrase or corrupted ciphertext.",
        provider: "core"
      });
    }
  }

  private validateIterations(iterations: number): void {
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw this.corrupted(
        `Invalid E2EE payload: iteration count ${iterations} is outside the accepted range (${MIN_ITERATIONS}-${MAX_ITERATIONS}).`
      );
    }
  }

  private corrupted(message: string): StorageError {
    return new StorageError({
      code: BYOCErrorCode.CORRUPTED_DATA,
      message,
      provider: "core",
      retryable: false
    });
  }

  private async *frameSource(
    source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
    frameSize: number
  ): AsyncGenerator<Buffer> {
    let frame = Buffer.allocUnsafe(frameSize);
    let used = 0;

    for await (const chunk of source) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const take = Math.min(frameSize - used, bytes.length - offset);
        bytes.copy(frame, used, offset, offset + take);
        used += take;
        offset += take;
        if (used === frameSize) {
          yield frame;
          frame = Buffer.allocUnsafe(frameSize);
          used = 0;
        }
      }
    }

    if (used > 0) yield frame.subarray(0, used);
  }

  private frameNonce(nonceBase: Buffer, index: number): Buffer {
    if (index > 0xffff_ffff) {
      throw this.corrupted("E2EE V3 frame counter exhausted.");
    }
    const nonce = Buffer.alloc(IV_LENGTH);
    nonceBase.copy(nonce, 0);
    nonce.writeUInt32BE(index, NONCE_BASE_LENGTH);
    return nonce;
  }

  private frameAad(header: Buffer, index: number, isFinal: boolean): Buffer {
    const suffix = Buffer.alloc(5);
    suffix.writeUInt32BE(index, 0);
    suffix[4] = isFinal ? 1 : 0;
    return Buffer.concat([header, suffix]);
  }

  private encryptFrame(
    plaintext: Buffer,
    index: number,
    isFinal: boolean,
    key: Buffer,
    nonceBase: Buffer,
    header: Buffer
  ): Buffer {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, this.frameNonce(nonceBase, index));
    cipher.setAAD(this.frameAad(header, index, isFinal));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const length = Buffer.alloc(FRAME_LENGTH_FIELD);
    length.writeUInt32BE(ciphertext.length, 0);
    return Buffer.concat([length, cipher.getAuthTag(), ciphertext]);
  }

  private decryptFrame(
    frame: { tag: Buffer; ciphertext: Buffer },
    index: number,
    isFinal: boolean,
    key: Buffer,
    nonceBase: Buffer,
    header: Buffer
  ): Buffer {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, this.frameNonce(nonceBase, index));
      decipher.setAAD(this.frameAad(header, index, isFinal));
      decipher.setAuthTag(frame.tag);
      return Buffer.concat([decipher.update(frame.ciphertext), decipher.final()]);
    } catch {
      throw new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "E2EE Decryption failed: Invalid passphrase or corrupted ciphertext.",
        provider: "core",
        retryable: false
      });
    }
  }

  private async readFrame(
    reader: AsyncByteReader,
    lengthField: Buffer,
    frameSize: number
  ): Promise<{ tag: Buffer; ciphertext: Buffer }> {
    const length = lengthField.readUInt32BE(0);
    if (length > frameSize) {
      throw this.corrupted(
        `Invalid E2EE V3 payload: frame length ${length} exceeds declared frame size ${frameSize}.`
      );
    }
    const tag = await reader.readExactly(TAG_LENGTH);
    const ciphertext = await reader.readExactly(length);
    return { tag, ciphertext };
  }

  private async collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(chunks));
  }
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array | string>;
  private buffered = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>) {
    const asyncSource = source as AsyncIterable<Uint8Array | string>;
    if (typeof asyncSource[Symbol.asyncIterator] === "function") {
      this.iterator = asyncSource[Symbol.asyncIterator]();
    } else {
      const syncIterator = (source as Iterable<Uint8Array | string>)[Symbol.iterator]();
      this.iterator = {
        next: async () => syncIterator.next()
      };
    }
  }

  public readExactly(length: number): Promise<Buffer>;
  public readExactly(length: number, allowEof: true): Promise<Buffer | null>;
  public async readExactly(length: number, allowEof = false): Promise<Buffer | null> {
    while (this.buffered.length < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = typeof next.value === "string" ? Buffer.from(next.value, "utf8") : Buffer.from(next.value);
      if (chunk.length > 0) this.buffered = Buffer.concat([this.buffered, chunk]);
    }

    if (allowEof && this.ended && this.buffered.length === 0) return null;
    if (this.buffered.length < length) {
      throw new StorageError({
        code: BYOCErrorCode.CORRUPTED_DATA,
        message: "Invalid E2EE payload: Truncated envelope.",
        provider: "core",
        retryable: false
      });
    }

    const output = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return output;
  }

  public async readRemaining(): Promise<Buffer> {
    const chunks = [this.buffered];
    this.buffered = Buffer.alloc(0);
    while (!this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      chunks.push(typeof next.value === "string" ? Buffer.from(next.value, "utf8") : Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  }
}

function storageInputAsStream(
  data: StorageInput
): AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> {
  if (typeof data === "string" || data instanceof Uint8Array) return [data];
  if (data instanceof ArrayBuffer) return [new Uint8Array(data)];
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Readable.fromWeb(data.stream() as never) as AsyncIterable<Uint8Array>;
  }
  if (data instanceof Readable) return data as AsyncIterable<Uint8Array | string>;
  if (typeof (data as ReadableStream).getReader === "function") {
    return Readable.fromWeb(data as never) as AsyncIterable<Uint8Array>;
  }
  throw new StorageError({
    code: BYOCErrorCode.INVALID_INPUT,
    message: "Unsupported E2EE stream input.",
    provider: "core",
    retryable: false
  });
}

function bufferedStorageInput(data: StorageInput): string | Uint8Array | undefined {
  if (typeof data === "string" || data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

function storageInputByteLength(data: StorageInput): number | undefined {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

async function collectStream(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Transparent Zero-Knowledge End-to-End Encryption Wrapper for ANY BYOC Storage Provider.
 */
export class EncryptedStorageWrapper implements BYOCProvider {
  private readonly crypto: E2EECrypto;

  constructor(
    public readonly provider: BYOCProvider,
    options: E2EEOptions
  ) {
    this.crypto = new E2EECrypto(options);
  }

  public manifest(): ProviderManifest {
    const base = this.provider.manifest();
    return {
      ...base,
      name: `${base.name} (E2EE Encrypted)`
    };
  }

  public async capabilities(): Promise<ProviderCapabilities> {
    return this.provider.capabilities();
  }

  public async connect(): Promise<void> {
    return this.provider.connect();
  }

  public async disconnect(): Promise<void> {
    return this.provider.disconnect();
  }

  public async upload(
    path: string,
    data: StorageInput,
    options?: UploadOptions
  ): Promise<StorageObject> {
    const inferredSize = storageInputByteLength(data);
    const plaintextSize = options?.contentLength ?? inferredSize;
    if (options?.contentLength !== undefined) {
      this.crypto.encryptedSize(options.contentLength);
      if (inferredSize !== undefined && inferredSize !== options.contentLength) {
        throw new StorageError({
          code: BYOCErrorCode.INVALID_INPUT,
          message: `Upload contentLength ${options.contentLength} does not match the ${inferredSize}-byte input.`,
          provider: "core",
          retryable: false
        });
      }
    }

    const encryptedOptions = (contentLength: number | undefined): UploadOptions => ({
      ...options,
      contentLength,
      mimeType: "application/octet-stream",
      metadata: {
        ...options?.metadata,
        byocEncryption: "BYOC_E2EE_V3",
        ...(options?.mimeType ? { byocOriginalMimeType: options.mimeType } : {})
      }
    });
    const exposePlaintextMetadata = (result: StorageObject): StorageObject => ({
      ...result,
      size: plaintextSize,
      mimeType: options?.mimeType,
      metadata: options?.metadata
    });

    const buffered = bufferedStorageInput(data);
    if (buffered !== undefined) {
      const encrypted = await this.crypto.encrypt(buffered);
      const result = await this.provider.upload(path, encrypted, encryptedOptions(encrypted.byteLength));
      return exposePlaintextMetadata(result);
    }

    const encryptedStream = Readable.from(this.crypto.encryptStream(storageInputAsStream(data)), {
      objectMode: false
    });
    const encryptedLength =
      plaintextSize === undefined ? undefined : this.crypto.encryptedSize(plaintextSize);
    const result = await this.provider.upload(
      path,
      encryptedStream,
      encryptedOptions(encryptedLength)
    );
    return exposePlaintextMetadata(result);
  }

  public async download(path: string): Promise<StorageOutput> {
    const encryptedMetadata = await this.provider.metadata(path);
    const decryptedSource = async (): Promise<AsyncIterable<Uint8Array>> => {
      const raw = await this.provider.download(path);
      return this.crypto.decryptStream(storageInputAsStream(raw.stream));
    };

    const stream = Readable.from(
      (async function* () {
        yield* await decryptedSource();
      })(),
      { objectMode: false }
    );
    let buffered: Promise<Buffer> | undefined;
    const readBuffered = (): Promise<Buffer> => {
      buffered ??= decryptedSource().then(collectStream);
      return buffered;
    };

    return {
      stream,
      arrayBuffer: async () => {
        const plain = await readBuffered();
        return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer;
      },
      text: async () => (await readBuffered()).toString("utf8"),
      metadata: {
        ...encryptedMetadata,
        size: undefined,
        mimeType:
          typeof encryptedMetadata.metadata?.byocOriginalMimeType === "string"
            ? encryptedMetadata.metadata.byocOriginalMimeType
            : undefined
      }
    };
  }

  public async delete(path: string): Promise<void> {
    return this.provider.delete(path);
  }

  public async list(path?: string): Promise<StorageObject[]> {
    return this.provider.list(path);
  }

  public async exists(path: string): Promise<boolean> {
    return this.provider.exists(path);
  }

  public async metadata(path: string): Promise<StorageObject> {
    return this.provider.metadata(path);
  }

  public async createFolder(path: string): Promise<StorageObject> {
    if (this.provider.createFolder) {
      return this.provider.createFolder(path);
    }
    throw new StorageError({
      code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
      message: "CreateFolder not supported by underlying provider.",
      provider: "core"
    });
  }

  public async copy(source: string, destination: string): Promise<void> {
    if (this.provider.copy) {
      return this.provider.copy(source, destination);
    }
    throw new StorageError({
      code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
      message: "Copy not supported by underlying provider.",
      provider: "core"
    });
  }

  public async move(source: string, destination: string): Promise<void> {
    if (this.provider.move) {
      return this.provider.move(source, destination);
    }
    throw new StorageError({
      code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
      message: "Move not supported by underlying provider.",
      provider: "core"
    });
  }

  public async quota(): Promise<StorageQuota> {
    if (this.provider.quota) {
      return this.provider.quota();
    }
    throw new StorageError({
      code: BYOCErrorCode.CAPABILITY_UNSUPPORTED,
      message: "Quota not supported by underlying provider.",
      provider: "core"
    });
  }

  public async backup(payload: StorageInput, options?: BackupOptions): Promise<StorageObject> {
    const folder = options?.folder ?? "Backups";
    const filename = options?.filename ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const targetPath = folder ? `${folder}/${filename}` : filename;

    return this.upload(targetPath, payload, {
      mimeType: options?.mimeType ?? "application/json",
      onProgress: options?.onProgress
    });
  }
}
