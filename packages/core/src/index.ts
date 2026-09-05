// Client
export { BYOC, type BYOCConfig } from "./client/byoc.js";

// Types
export type {
  BYOCProvider,
  ProviderManifest,
  ProviderCapabilities,
  ProviderCategory,
  AuthType
} from "./types/provider.js";

export type {
  StorageObject,
  StorageInput,
  StorageOutput,
  StorageQuota,
  UploadOptions,
  UploadProgress,
  BackupOptions,
  BatchDeleteReport,
  BatchFailure,
  SignedUrlOptions,
  UploadGrant,
  UploadGrantOptions
} from "./types/storage.js";

// Errors
export { BYOCErrorCode } from "./errors/codes.js";
export { StorageError, type StorageErrorOptions } from "./errors/storage-error.js";

// Path Utilities
export {
  normalizeVirtualPath,
  getBasename,
  getDirname,
  splitPath,
  rfc3986UriEncode,
  encodePathSegments
} from "./paths/resolver.js";

// Migration Engine
export {
  MigrationEngine,
  type MigrationOptions,
  type MigrationReport,
  type MigrationProgress,
  type MigrationFileResult,
  type ConflictStrategy
} from "./migration/engine.js";

// End-to-End Encryption
export {
  E2EECrypto,
  EncryptedStorageWrapper,
  E2EE_MAGIC_HEADER_V3,
  E2EE_V3_HEADER_LENGTH,
  E2EE_V3_DEFAULT_FRAME_SIZE,
  E2EE_V3_MIN_FRAME_SIZE,
  E2EE_V3_MAX_FRAME_SIZE,
  type E2EEOptions
} from "./encryption/e2ee.js";

// Utilities
export { withRetry, type RetryOptions } from "./utils/retry.js";
export { SafeLogger, SilentLogger, type LogLevel, type BYOCLogger } from "./utils/logger.js";
export { lookupMimeType } from "./utils/mime.js";
