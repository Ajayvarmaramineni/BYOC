import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { E2EECrypto, EncryptedStorageWrapper } from "../../src/encryption/e2ee.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";
import type { BYOCProvider } from "../../src/types/provider.js";

function createMockProvider(): BYOCProvider {
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
      resumableUploads: false,
      versioning: false,
      quota: false,
      serverSideCopy: true
    }),
    connect: async () => {},
    disconnect: async () => {},
    upload: async (path, data) => {
      const bytes = Buffer.from(data as any);
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
        stream: null as any,
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
    expect(() => new E2EECrypto({ passphrase, keyDerivationIterations: 100 })).toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.INVALID_INPUT
      })
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
    expect(rawText.startsWith("BYOC_E2EE_V2")).toBe(true);

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

  it("forces resumableUploads to false in capabilities", async () => {
    const mockCloud = createMockProvider();
    const secureStorage = new EncryptedStorageWrapper(mockCloud, { passphrase });
    const caps = await secureStorage.capabilities();

    expect(caps.resumableUploads).toBe(false);
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
    expect(rawText.startsWith("BYOC_E2EE_V2")).toBe(true);
  });
});
