import crypto from "node:crypto";
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
import { E2EECrypto, EncryptedStorageWrapper } from "../../src/encryption/e2ee.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";
import type { BYOCProvider } from "../../src/types/provider.js";

function createMockProvider(
  onUpload?: (
    data: Parameters<BYOCProvider["upload"]>[1],
    options: Parameters<BYOCProvider["upload"]>[2]
  ) => void
): BYOCProvider {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: () => ({
      id: "mock-backend",
      name: "Mock Cloud",
      category: "developer-cloud",
      authentication: "access-key",
      supportsUserOwnedStorage: true,
      adapterVersion: "0.1.0"
    }),
    capabilities: () => ({
      folders: true,
      sharing: false,
      publicUrls: false,
      resumableUploads: true,
      versioning: false,
      quota: false,
      serverSideCopy: true
    }),
    connect: async () => {},
    disconnect: async () => {},
    upload: async (path, data, options) => {
      onUpload?.(data, options);
      let bytes: Buffer;
      if (typeof data === "string" || data instanceof Uint8Array || data instanceof ArrayBuffer) {
        bytes = Buffer.from(data as any);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of data as any) chunks.push(Buffer.from(chunk));
        bytes = Buffer.concat(chunks);
      }
      store.set(path, new Uint8Array(bytes));
      return {
        id: `mock_${path}`,
        path,
        name: path,
        provider: "mock-backend",
        providerId: path,
        size: bytes.length
      };
    },
    download: async (path) => {
      const data = store.get(path);
      if (!data) throw new Error("Not found");
      return {
        stream: Readable.from([Buffer.from(data)]),
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        text: async () => new TextDecoder().decode(data),
        metadata: {
          id: `mock_${path}`,
          path,
          name: path,
          provider: "mock-backend",
          providerId: path,
          size: data.length
        }
      };
    },
    delete: async (path) => { store.delete(path); },
    list: async () => [],
    exists: async (path) => store.has(path),
    metadata: async (path) => ({
      id: `mock_${path}`,
      path,
      name: path,
      provider: "mock-backend",
      providerId: path
    })
  };
}

describe("Zero-Knowledge End-to-End Encryption (E2EE)", () => {
  const passphrase = "correct-horse-battery-staple-passphrase-999";

  it("encrypts and decrypts strings and binary buffers roundtrip", async () => {
    const crypto = new E2EECrypto({ passphrase });
    const originalText = "Top Secret Personal Health Record & Banking Info";

    const cipherBytes = await crypto.encrypt(originalText);
    expect(cipherBytes.length).toBeGreaterThan(originalText.length);
    // Ciphertext should not contain plaintext
    expect(new TextDecoder().decode(cipherBytes)).not.toContain("Top Secret");

    const decryptedBytes = await crypto.decrypt(cipherBytes);
    expect(new TextDecoder().decode(decryptedBytes)).toBe(originalText);
  });

  it("transparently supports custom/legacy iteration counts encoded in envelope header", async () => {
    const legacyCrypto = new E2EECrypto({ passphrase, keyDerivationIterations: 20000 });
    const modernCrypto = new E2EECrypto({ passphrase, keyDerivationIterations: 600000 });

    const originalText = "Historical Data Encrypted with 20k Iterations";
    const legacyCipher = await legacyCrypto.encrypt(originalText);

    // Modern client with 600k default seamlessly decrypts 20k file using envelope header
    const decrypted = await modernCrypto.decrypt(legacyCipher);
    expect(new TextDecoder().decode(decrypted)).toBe(originalText);
  });

  it("detects tampering with iteration header count via GCM AAD", async () => {
    const crypto = new E2EECrypto({ passphrase });
    const cipherBytes = await crypto.encrypt("Sensitive Document");

    // Tamper with iteration count byte in header (offset 12..16)
    const tampered = new Uint8Array(cipherBytes);
    tampered[13] = (tampered[13]! + 1) % 256;

    await expect(crypto.decrypt(tampered)).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.AUTH_REQUIRED
      })
    );
  });

  it("rejects an out-of-range iteration count before deriving a key", async () => {
    const crypto = new E2EECrypto({ passphrase });
    const cipherBytes = await crypto.encrypt("Sensitive Document");

    // A hostile but Node-legal work factor (2e9) would cost minutes of PBKDF2
    // on a threadpool thread if it were honoured before the tag check.
    const poisoned = new Uint8Array(cipherBytes);
    const iterBuf = Buffer.alloc(4);
    iterBuf.writeUInt32BE(2_000_000_000, 0);
    poisoned.set(iterBuf, 12);

    const start = Date.now();
    await expect(crypto.decrypt(poisoned)).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.CORRUPTED_DATA
      })
    );
    // Must be rejected up front, not after doing the work.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("rejects an iteration count below the minimum work factor", async () => {
    const crypto = new E2EECrypto({ passphrase });
    const cipherBytes = await crypto.encrypt("Sensitive Document");

    const weakened = new Uint8Array(cipherBytes);
    const iterBuf = Buffer.alloc(4);
    iterBuf.writeUInt32BE(1, 0);
    weakened.set(iterBuf, 12);

    await expect(crypto.decrypt(weakened)).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.CORRUPTED_DATA
      })
    );
  });

  it("rejects construction with an out-of-range keyDerivationIterations", () => {
    for (const keyDerivationIterations of [0, 100, 10_000.5]) {
      expect(() => new E2EECrypto({ passphrase, keyDerivationIterations })).toThrowError(
        expect.objectContaining({
          code: BYOCErrorCode.INVALID_INPUT
        })
      );
    }

    expect(() => new E2EECrypto({ passphrase, frameSize: 4096.5 })).toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.INVALID_INPUT
      })
    );
  });

  it("calculates exact framed envelope sizes", () => {
    const crypto = new E2EECrypto({ passphrase, frameSize: 4096 });

    expect(crypto.encryptedSize(0)).toBe(64);
    expect(crypto.encryptedSize(4096)).toBe(4160);
    expect(crypto.encryptedSize(4097)).toBe(4181);
    expect(() => crypto.encryptedSize(-1)).toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.INVALID_INPUT })
    );
    expect(() => crypto.encryptedSize(0x1_0000_0000 * 4096 + 1)).toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.INVALID_INPUT })
    );
  });

  it("rejects decryption with an invalid passphrase (tamper-proof)", async () => {
    const cryptoAlice = new E2EECrypto({ passphrase: "alice-correct-password" });
    const cryptoEve = new E2EECrypto({ passphrase: "eve-wrong-password-attacker" });

    const cipherBytes = await cryptoAlice.encrypt("Confidential Document");

    await expect(cryptoEve.decrypt(cipherBytes)).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.AUTH_REQUIRED
      })
    );
  });

  it("transparently supports legacy BYOC_E2EE_V1 envelopes", async () => {
    const modernCrypto = new E2EECrypto({ passphrase });
    const legacyText = "Original File Encrypted with Legacy V1 Envelope";
    const dataBytes = Buffer.from(legacyText, "utf8");
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);

    // Derive with legacy fixed 100k
    const derivedKey = crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, 100000, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
    const aad = Buffer.concat([Buffer.from("BYOC_E2EE_V1"), salt]);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(dataBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    const legacyPayload = Buffer.concat([
      Buffer.from("BYOC_E2EE_V1"),
      salt,
      iv,
      tag,
      encrypted
    ]);

    const decrypted = await modernCrypto.decrypt(legacyPayload);
    expect(new TextDecoder().decode(decrypted)).toBe(legacyText);
  });

  it("transparently encrypts on upload and decrypts on download with EncryptedStorageWrapper", async () => {
    const mockCloud = createMockProvider();
    const secureStorage = new EncryptedStorageWrapper(mockCloud, { passphrase });

    await secureStorage.upload("documents/confidential.txt", "Sensitive Patient Records");

    // Verify underlying provider received raw encrypted bytes
    const rawCipher = await mockCloud.download("documents/confidential.txt");
    const rawText = await rawCipher.text();
    expect(rawText).not.toContain("Sensitive Patient Records");
    expect(rawText.startsWith("BYOC_E2EE_V3")).toBe(true);

    // Verify wrapper transparently decrypts
    const decrypted = await secureStorage.download("documents/confidential.txt");
    expect(await decrypted.text()).toBe("Sensitive Patient Records");

    // Verify stream is also plaintext (no ciphertext leak in stream)
    const streamChunks: Buffer[] = [];
    for await (const chunk of decrypted.stream) {
      streamChunks.push(Buffer.from(chunk));
    }
    const streamText = Buffer.concat(streamChunks).toString("utf-8");
    expect(streamText).toBe("Sensitive Patient Records");
  });

  it("preserves resumable upload support now that encryption is framed", async () => {
    const mockCloud = createMockProvider();
    const secureStorage = new EncryptedStorageWrapper(mockCloud, { passphrase });
    const caps = await secureStorage.capabilities();

    expect(caps.resumableUploads).toBe(true);
  });

  it("keeps buffered uploads buffered and encrypts true streams incrementally", async () => {
    const received: Array<{ data: unknown; contentLength?: number }> = [];
    const mockCloud = createMockProvider((data, options) => {
      received.push({ data, contentLength: options?.contentLength });
    });
    const secureStorage = new EncryptedStorageWrapper(mockCloud, {
      passphrase,
      keyDerivationIterations: 10000,
      frameSize: 4096
    });

    const bufferedResult = await secureStorage.upload("buffered.txt", "retryable and payload-signed");
    expect(received[0]?.data).toBeInstanceOf(Uint8Array);
    expect(received[0]?.contentLength).toBe(92);
    expect(bufferedResult.size).toBe(28);

    await secureStorage.upload("streamed.txt", Readable.from(["incremental ", "ciphertext"]), {
      contentLength: 22
    });
    expect(received[1]?.data).toBeInstanceOf(Readable);
    expect(received[1]?.contentLength).toBe(86);
    const downloaded = await secureStorage.download("streamed.txt");
    expect(await downloaded.text()).toBe("incremental ciphertext");
  });

  it("encrypts backup payloads before uploading", async () => {
    const mockCloud = createMockProvider();
    const secureStorage = new EncryptedStorageWrapper(mockCloud, { passphrase });

    await secureStorage.backup(JSON.stringify({ secret: "apiKey123" }), {
      filename: "encrypted_backup.json"
    });

    const rawCipher = await mockCloud.download("Backups/encrypted_backup.json");
    const rawText = await rawCipher.text();
    expect(rawText).not.toContain("apiKey123");
    expect(rawText.startsWith("BYOC_E2EE_V3")).toBe(true);
  });

  it("streams across arbitrary input and transport chunk boundaries", async () => {
    const crypto = new E2EECrypto({
      passphrase,
      keyDerivationIterations: 10000,
      frameSize: 4096
    });
    const plaintext = Buffer.from("stream-boundary-check-".repeat(700));

    async function* source() {
      for (let offset = 0; offset < plaintext.length; offset += 733) {
        yield plaintext.subarray(offset, offset + 733);
      }
    }

    const encryptedChunks: Buffer[] = [];
    for await (const chunk of crypto.encryptStream(source())) encryptedChunks.push(Buffer.from(chunk));
    const envelope = Buffer.concat(encryptedChunks);

    async function* hostileTransport() {
      for (let offset = 0; offset < envelope.length; offset += 97) {
        yield envelope.subarray(offset, offset + 97);
      }
    }

    const decrypted: Buffer[] = [];
    for await (const chunk of crypto.decryptStream(hostileTransport())) decrypted.push(Buffer.from(chunk));
    expect(Buffer.concat(decrypted)).toEqual(plaintext);
    expect(encryptedChunks.length).toBeGreaterThan(3);
  });

  it("emits one authenticated frame for an empty object", async () => {
    const crypto = new E2EECrypto({ passphrase, keyDerivationIterations: 10000 });
    const envelope = Buffer.from(await crypto.encrypt(new Uint8Array()));

    expect(envelope.subarray(0, 12).toString()).toBe("BYOC_E2EE_V3");
    expect(envelope.length).toBe(44 + 4 + 16);
    expect(await crypto.decrypt(envelope)).toEqual(new Uint8Array());
  });

  it("detects removed, reordered, oversized, and header-tampered V3 frames", async () => {
    const crypto = new E2EECrypto({
      passphrase,
      keyDerivationIterations: 10000,
      frameSize: 4096
    });
    const envelope = Buffer.from(await crypto.encrypt(Buffer.alloc(9000, 0x5a)));
    const recordSize = 4 + 16 + 4096;
    const header = envelope.subarray(0, 44);
    const first = envelope.subarray(44, 44 + recordSize);
    const second = envelope.subarray(44 + recordSize, 44 + recordSize * 2);
    const final = envelope.subarray(44 + recordSize * 2);

    await expect(crypto.decrypt(Buffer.concat([header, first, second]))).rejects.toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.AUTH_REQUIRED })
    );
    await expect(crypto.decrypt(Buffer.concat([header, second, first, final]))).rejects.toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.AUTH_REQUIRED })
    );

    const oversized = Buffer.from(envelope);
    oversized.writeUInt32BE(0xffff_ffff, 44);
    await expect(crypto.decrypt(oversized)).rejects.toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.CORRUPTED_DATA })
    );

    const invalidFrameSize = Buffer.from(envelope);
    invalidFrameSize.writeUInt32BE(16, 16);
    await expect(crypto.decrypt(invalidFrameSize)).rejects.toThrowError(
      expect.objectContaining({ code: BYOCErrorCode.CORRUPTED_DATA })
    );
  });
});
