import { BYOCErrorCode, StorageError } from "@byoc/core";

export interface GoogleApiErrorResponse {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      message?: string;
      domain?: string;
      reason?: string;
      location?: string;
    }>;
    status?: string;
  };
}

/**
 * Maps raw Google Drive REST API error responses and HTTP status codes
 * to standard normalized BYOC StorageError instances.
 */
export function mapGoogleDriveError(rawError: unknown): StorageError {
  if (StorageError.isStorageError(rawError)) {
    return rawError;
  }

  const err = rawError as any;
  const status = Number(err?.status ?? err?.code ?? err?.statusCode ?? err?.response?.status ?? 0);
  const responseData: GoogleApiErrorResponse | undefined = err?.response?.data ?? err?.data;
  const reason = responseData?.error?.errors?.[0]?.reason ?? err?.reason ?? "";
  const rawMessage = responseData?.error?.message ?? err?.message ?? "An unknown Google Drive error occurred.";

  // 1. Authentication / Token issues
  if (status === 401 || reason === "authError" || reason === "invalid_grant") {
    return new StorageError({
      code: BYOCErrorCode.AUTH_REQUIRED,
      message: `Google Drive authentication required: ${rawMessage}`,
      provider: "google-drive",
      statusCode: 401,
      retryable: false,
      rawError
    });
  }

  // 2. Storage Quota Exceeded
  if (
    reason === "storageQuotaExceeded" ||
    reason === "quotaExceeded" ||
    rawMessage.toLowerCase().includes("quota exceeded")
  ) {
    return new StorageError({
      code: BYOCErrorCode.QUOTA_EXCEEDED,
      message: `Google Drive storage quota exceeded: ${rawMessage}`,
      provider: "google-drive",
      statusCode: 403,
      retryable: false,
      rawError
    });
  }

  // 3. Rate limiting / Throttling
  if (
    status === 429 ||
    reason === "userRateLimitExceeded" ||
    reason === "rateLimitExceeded" ||
    reason === "dailyLimitExceeded"
  ) {
    return new StorageError({
      code: BYOCErrorCode.RATE_LIMITED,
      message: `Google Drive rate limit exceeded: ${rawMessage}`,
      provider: "google-drive",
      statusCode: 429,
      retryable: true,
      rawError
    });
  }

  // 4. File or folder not found
  if (status === 404 || reason === "notFound") {
    return new StorageError({
      code: BYOCErrorCode.OBJECT_NOT_FOUND,
      message: `Google Drive object not found: ${rawMessage}`,
      provider: "google-drive",
      statusCode: 404,
      retryable: false,
      rawError
    });
  }

  // 5. Permission denied
  if (status === 403 || reason === "forbidden" || reason === "insufficientFilePermissions") {
    return new StorageError({
      code: BYOCErrorCode.PERMISSION_DENIED,
      message: `Google Drive permission denied: ${rawMessage}`,
      provider: "google-drive",
      statusCode: 403,
      retryable: false,
      rawError
    });
  }

  // 6. Provider Unavailable / Transient Backend Error
  if (status === 500 || status === 502 || status === 503 || status === 504 || reason === "backendError") {
    return new StorageError({
      code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
      message: `Google Drive service temporarily unavailable (${status || "5xx"}): ${rawMessage}`,
      provider: "google-drive",
      statusCode: status || 503,
      retryable: true,
      rawError
    });
  }

  // Fallback generic error
  return new StorageError({
    code: BYOCErrorCode.UPLOAD_FAILED,
    message: `Google Drive error: ${rawMessage}`,
    provider: "google-drive",
    statusCode: status || undefined,
    retryable: false,
    rawError
  });
}
