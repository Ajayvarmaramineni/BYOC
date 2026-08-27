import type { GoogleDriveTokenSession, GoogleTokenStorage } from "./types.js";
import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Default in-memory token storage.
 * Sessions are preserved during application runtime and cleared on disconnect/restart.
 */
export class InMemoryTokenStorage implements GoogleTokenStorage {
  private session: GoogleDriveTokenSession | null = null;

  constructor(initialSession?: GoogleDriveTokenSession) {
    if (initialSession) {
      this.session = { ...initialSession };
    }
  }

  public get(): GoogleDriveTokenSession | null {
    return this.session ? { ...this.session } : null;
  }

  public set(session: GoogleDriveTokenSession): void {
    this.session = { ...session };
  }

  public clear(): void {
    this.session = null;
  }
}

export interface EncryptedFileStorageOptions {
  filePath: string;
  encryptionKey: string | Buffer;
}

/**
 * Encrypted file-based token storage using AES-256-GCM authenticated encryption.
 * Persists OAuth refresh tokens securely across application restarts.
 */
export class EncryptedFileTokenStorage implements GoogleTokenStorage {
  private readonly filePath: string;
  private readonly key: Buffer;

  constructor(options: EncryptedFileStorageOptions) {
    this.filePath = options.filePath;
    if (typeof options.encryptionKey === "string") {
      this.key = crypto.createHash("sha256").update(options.encryptionKey).digest();
    } else {
      this.key = options.encryptionKey;
    }
  }

  public get(): GoogleDriveTokenSession | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const { iv, tag, data } = JSON.parse(raw);

      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "hex"));
      decipher.setAuthTag(Buffer.from(tag, "hex"));

      let decrypted = decipher.update(data, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted) as GoogleDriveTokenSession;
    } catch {
      return null;
    }
  }

  public set(session: GoogleDriveTokenSession): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);

    let encrypted = cipher.update(JSON.stringify(session), "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();

    const payload = JSON.stringify({
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted
    });

    fs.writeFileSync(this.filePath, payload, "utf8");
  }

  public clear(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // Ignore deletion errors
      }
    }
  }
}
