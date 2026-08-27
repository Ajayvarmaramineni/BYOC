/**
 * Standardized error codes across all BYOC providers.
 * Core code and client layers strictly use these provider-neutral codes.
 */
export const BYOCErrorCode = {
  /** Authentication is missing, invalid, or expired. Re-auth required. */
  AUTH_REQUIRED: "BYOC_AUTH_REQUIRED",
  /** The requested object or folder path was not found. */
  OBJECT_NOT_FOUND: "BYOC_OBJECT_NOT_FOUND",
  /** Permission denied by provider (e.g. read-only access or insufficient scope). */
  PERMISSION_DENIED: "BYOC_PERMISSION_DENIED",
  /** The target cloud account has exceeded its storage quota. */
  QUOTA_EXCEEDED: "BYOC_QUOTA_EXCEEDED",
  /** Provider rate limit or query limit exceeded (temporary / retryable). */
  RATE_LIMITED: "BYOC_RATE_LIMITED",
  /** Upload failed during binary transmission or chunk assembly. */
  UPLOAD_FAILED: "BYOC_UPLOAD_FAILED",
  /** Download failed or connection was severed during streaming. */
  DOWNLOAD_FAILED: "BYOC_DOWNLOAD_FAILED",
  /** Provider service is down or temporarily unreachable (5xx/network). */
  PROVIDER_UNAVAILABLE: "BYOC_PROVIDER_UNAVAILABLE",
  /** Authentication token is expired and refresh failed. */
  TOKEN_EXPIRED: "BYOC_TOKEN_EXPIRED",
  /** Conflict detected (e.g. naming clash or concurrent modification). */
  CONFLICT: "BYOC_CONFLICT",
  /** The target object already exists on the destination provider. */
  OBJECT_ALREADY_EXISTS: "BYOC_OBJECT_ALREADY_EXISTS",
  /** The connected provider does not support the requested operation. */
  CAPABILITY_UNSUPPORTED: "BYOC_CAPABILITY_UNSUPPORTED",
  /** Input validation failed (e.g. invalid virtual path, directory traversal). */
  INVALID_INPUT: "BYOC_INVALID_INPUT",
  /** Ciphertext payload or metadata is corrupted or malformed. */
  CORRUPTED_DATA: "BYOC_CORRUPTED_DATA"
} as const;

export type BYOCErrorCode = typeof BYOCErrorCode[keyof typeof BYOCErrorCode];
