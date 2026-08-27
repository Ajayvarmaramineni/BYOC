import { BYOCErrorCode } from "./codes.js";

export interface StorageErrorOptions {
  code: BYOCErrorCode;
  message: string;
  provider: string;
  statusCode?: number;
  retryable?: boolean;
  rawError?: unknown;
}

/**
 * Standard normalized error thrown by BYOC Core and all provider adapters.
 */
export class StorageError extends Error {
  public readonly code: BYOCErrorCode;
  public readonly provider: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;
  public readonly rawError?: unknown;

  constructor(options: StorageErrorOptions) {
    super(options.message);
    this.name = "StorageError";
    this.code = options.code;
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.rawError = options.rawError;

    // Maintain proper stack trace in V8 engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StorageError);
    }
  }

  /**
   * Helper to check if an unknown error is an instance of StorageError.
   */
  public static isStorageError(error: unknown): error is StorageError {
    return error instanceof StorageError;
  }

  /**
   * Converts the error into a clean JSON-serializable log representation
   * without leaking sensitive tokens or credential objects in rawError.
   */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      statusCode: this.statusCode,
      retryable: this.retryable
    };
  }
}
