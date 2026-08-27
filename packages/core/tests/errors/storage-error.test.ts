import { describe, it, expect } from "vitest";
import { StorageError } from "../../src/errors/storage-error.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";

describe("StorageError", () => {
  it("instantiates properly with all required and optional properties", () => {
    const raw = { originalCode: 429 };
    const err = new StorageError({
      code: BYOCErrorCode.RATE_LIMITED,
      message: "Too many requests to Google Drive",
      provider: "google-drive",
      statusCode: 429,
      retryable: true,
      rawError: raw
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.name).toBe("StorageError");
    expect(err.code).toBe(BYOCErrorCode.RATE_LIMITED);
    expect(err.message).toBe("Too many requests to Google Drive");
    expect(err.provider).toBe("google-drive");
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.rawError).toBe(raw);
  });

  it("defaults retryable to false if omitted", () => {
    const err = new StorageError({
      code: BYOCErrorCode.OBJECT_NOT_FOUND,
      message: "File not found",
      provider: "google-drive"
    });

    expect(err.retryable).toBe(false);
  });

  it("isStorageError type guard works accurately", () => {
    const storageErr = new StorageError({
      code: BYOCErrorCode.AUTH_REQUIRED,
      message: "Unauthorized",
      provider: "core"
    });
    const standardErr = new Error("Standard error");
    const plainObject = { code: "BYOC_AUTH_REQUIRED" };

    expect(StorageError.isStorageError(storageErr)).toBe(true);
    expect(StorageError.isStorageError(standardErr)).toBe(false);
    expect(StorageError.isStorageError(plainObject)).toBe(false);
    expect(StorageError.isStorageError(null)).toBe(false);
  });

  it("toJSON serializes cleanly without leaking raw secret objects", () => {
    const err = new StorageError({
      code: BYOCErrorCode.AUTH_REQUIRED,
      message: "Token expired",
      provider: "google-drive",
      statusCode: 401,
      retryable: false,
      rawError: { sensitiveToken: "SECRET_TOKEN_123" }
    });

    const json = err.toJSON();
    expect(json).toEqual({
      name: "StorageError",
      code: "BYOC_AUTH_REQUIRED",
      message: "Token expired",
      provider: "google-drive",
      statusCode: 401,
      retryable: false
    });
    expect((json as any).rawError).toBeUndefined();
  });
});
