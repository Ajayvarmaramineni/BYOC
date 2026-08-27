import { describe, it, expect } from "vitest";
import { mapGoogleDriveError } from "../../src/errors/mapper.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("Google Drive Error Mapper", () => {
  it("passes through existing StorageError unmodified", () => {
    const original = new StorageError({
      code: BYOCErrorCode.AUTH_REQUIRED,
      message: "Already mapped",
      provider: "google-drive"
    });
    const mapped = mapGoogleDriveError(original);
    expect(mapped).toBe(original);
  });

  it("maps 401 and authError to BYOC_AUTH_REQUIRED", () => {
    const googleErr = {
      status: 401,
      response: {
        data: {
          error: {
            code: 401,
            message: "Invalid Credentials",
            errors: [{ reason: "authError" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(googleErr);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe(BYOCErrorCode.AUTH_REQUIRED);
    expect(err.statusCode).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe("google-drive");
  });

  it("maps storage quota exceeded to BYOC_QUOTA_EXCEEDED", () => {
    const quotaErr = {
      status: 403,
      response: {
        data: {
          error: {
            code: 403,
            message: "The user's Drive storage quota has been exceeded.",
            errors: [{ reason: "storageQuotaExceeded" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(quotaErr);
    expect(err.code).toBe(BYOCErrorCode.QUOTA_EXCEEDED);
    expect(err.statusCode).toBe(403);
    expect(err.retryable).toBe(false);
  });

  it("maps 429 rate limit exceeded to BYOC_RATE_LIMITED with retryable=true", () => {
    const rateLimitErr = {
      status: 429,
      response: {
        data: {
          error: {
            code: 429,
            message: "User Rate Limit Exceeded",
            errors: [{ reason: "userRateLimitExceeded" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(rateLimitErr);
    expect(err.code).toBe(BYOCErrorCode.RATE_LIMITED);
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it("maps 404 notFound to BYOC_OBJECT_NOT_FOUND", () => {
    const notFoundErr = {
      status: 404,
      response: {
        data: {
          error: {
            code: 404,
            message: "File not found: abc123",
            errors: [{ reason: "notFound" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(notFoundErr);
    expect(err.code).toBe(BYOCErrorCode.OBJECT_NOT_FOUND);
    expect(err.statusCode).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it("maps 503 backendError to BYOC_PROVIDER_UNAVAILABLE with retryable=true", () => {
    const backendErr = {
      status: 503,
      response: {
        data: {
          error: {
            code: 503,
            message: "Backend Error",
            errors: [{ reason: "backendError" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(backendErr);
    expect(err.code).toBe(BYOCErrorCode.PROVIDER_UNAVAILABLE);
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it("maps 403 forbidden to BYOC_PERMISSION_DENIED", () => {
    const forbiddenErr = {
      status: 403,
      response: {
        data: {
          error: {
            code: 403,
            message: "The caller does not have permission",
            errors: [{ reason: "forbidden" }]
          }
        }
      }
    };

    const err = mapGoogleDriveError(forbiddenErr);
    expect(err.code).toBe(BYOCErrorCode.PERMISSION_DENIED);
    expect(err.statusCode).toBe(403);
    expect(err.retryable).toBe(false);
  });
});
