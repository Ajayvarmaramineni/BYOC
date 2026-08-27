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
}

const E2EE_MAGIC_HEADER_V1 = Buffer.from("BYOC_E2EE_V1"); // 12 bytes (legacy v0.1 format, 100k fixed iter)
const E2EE_MAGIC_HEADER_V2 = Buffer.from("BYOC_E2EE_V2"); // 12 bytes (v0.2 format, dynamic 4-byte iter)
const ITER_LENGTH = 4; // 4-byte big-endian unsigned integer
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH_V1 = E2EE_MAGIC_HEADER_V1.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
const HEADER_LENGTH_V2 = E2EE_MAGIC_HEADER_V2.length + ITER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

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

  constructor(options: E2EEOptions) {
    if (!options.passphrase && !options.masterKey) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "E2EECrypto requires either a 'passphrase' or 'masterKey'.",
        provider: "core"
      });
    }

    this.iterations = options.keyDerivationIterations || 600000;

    if (this.iterations < MIN_ITERATIONS || this.iterations > MAX_ITERATIONS) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `E2EECrypto 'keyDerivationIterations' must be between ${MIN_ITERATIONS} and ${MAX_ITERATIONS} (received ${this.iterations}).`,
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

  /**
   * Asynchronously derives a 256-bit AES key from passphrase and salt using PBKDF2.
   * Runs in the libuv threadpool to avoid blocking the event loop.
   */
  private async deriveKey(salt: Buffer, iterations: number): Promise<Buffer> {
    return pbkdf2Async(this.masterKey, salt, iterations, 32, "sha256");
  }

  /**
   * Encrypts plaintext bytes returning an envelope containing [MAGIC_V2 + ITER + SALT + IV + TAG + CIPHERTEXT].
   */
  public async encrypt(plaintext: Uint8Array | string): Promise<Uint8Array> {
    const dataBytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const iterBuf = Buffer.alloc(ITER_LENGTH);
    iterBuf.writeUInt32BE(this.iterations, 0);

    const derivedKey = await this.deriveKey(salt, this.iterations);
    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);

    // Cryptographically bind envelope header metadata (magic + iterations + salt) as GCM AAD
    const aad = Buffer.concat([E2EE_MAGIC_HEADER_V2, iterBuf, salt]);
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(dataBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    const output = Buffer.concat([
      E2EE_MAGIC_HEADER_V2,
      iterBuf,
      salt,
      iv,
      tag,
      encrypted
    ]);

    return new Uint8Array(output);
  }

  /**
   * Decrypts an envelope payload [MAGIC + (ITER) + SALT + IV + TAG + CIPHERTEXT] using AES-256-GCM.
   * Transparently supports both V2 (dynamic iteration) and V1 (legacy 100k iteration) envelope formats.
   */
  public async decrypt(envelopeBytes: Uint8Array): Promise<Uint8Array> {
    const buf = Buffer.from(envelopeBytes);

    if (buf.length < HEADER_LENGTH_V1) {
      throw new StorageError({
        code: BYOCErrorCode.CORRUPTED_DATA,
        message: "Invalid E2EE payload: Data is shorter than header size.",
        provider: "core"
      });
    }

    const isV2 = buf.subarray(0, E2EE_MAGIC_HEADER_V2.length).equals(E2EE_MAGIC_HEADER_V2);
    const isV1 = buf.subarray(0, E2EE_MAGIC_HEADER_V1.length).equals(E2EE_MAGIC_HEADER_V1);

    if (!isV2 && !isV1) {
      throw new StorageError({
        code: BYOCErrorCode.CORRUPTED_DATA,
        message: "Invalid E2EE payload: Missing or unrecognized magic header.",
        provider: "core"
      });
    }

    let offset = 12;
    let fileIterations: number;
    let aad: Buffer;

    if (isV2) {
      if (buf.length < HEADER_LENGTH_V2) {
        throw new StorageError({
          code: BYOCErrorCode.CORRUPTED_DATA,
          message: "Invalid E2EE V2 payload: Data is shorter than header size.",
          provider: "core"
        });
      }

      const iterBuf = buf.subarray(offset, offset + ITER_LENGTH);
      fileIterations = iterBuf.readUInt32BE(0);

      // Range-check before deriving: this value comes from untrusted storage and
      // is consumed before the GCM tag can authenticate it.
      if (fileIterations < MIN_ITERATIONS || fileIterations > MAX_ITERATIONS) {
        throw new StorageError({
          code: BYOCErrorCode.CORRUPTED_DATA,
          message: `Invalid E2EE payload: iteration count ${fileIterations} is outside the accepted range (${MIN_ITERATIONS}-${MAX_ITERATIONS}).`,
          provider: "core",
          retryable: false
        });
      }
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
    const base = await this.provider.capabilities();
    return {
      ...base,
      resumableUploads: false // Resumable multipart requires coordinated chunk encryption
    };
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
    let rawBytes: Uint8Array;

    if (typeof data === "string") {
      rawBytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      rawBytes = data;
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      rawBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      rawBytes = new Uint8Array(data);
    } else {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "E2EE upload currently requires buffered binary or string data.",
        provider: "core"
      });
    }

    const cipherBytes = await this.crypto.encrypt(rawBytes);
    return this.provider.upload(path, cipherBytes, {
      ...options,
      mimeType: "application/octet-stream"
    });
  }

  public async download(path: string): Promise<StorageOutput> {
    const rawOutput = await this.provider.download(path);
    const cipherBuffer = await rawOutput.arrayBuffer();
    const plainBytes = await this.crypto.decrypt(new Uint8Array(cipherBuffer));
    const plainBuf = Buffer.from(plainBytes.buffer, plainBytes.byteOffset, plainBytes.byteLength);

    return {
      stream: Readable.from([plainBuf]) as any,
      arrayBuffer: async () => plainBytes.buffer.slice(plainBytes.byteOffset, plainBytes.byteOffset + plainBytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(plainBytes),
      metadata: {
        ...rawOutput.metadata,
        size: plainBytes.byteLength
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
