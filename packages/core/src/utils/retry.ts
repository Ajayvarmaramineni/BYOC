import { StorageError } from "../errors/storage-error.js";

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds before the first retry (default: 500ms) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 10000ms) */
  maxDelayMs?: number;
  /** Custom predicate to determine if an error is retryable */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Calculates exponential backoff delay with full randomized jitter.
 * Formula: Math.min(maxDelay, baseDelay * 2^(attempt - 1)) * random(0.5, 1.5)
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number = 500,
  maxDelayMs: number = 10000
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(maxDelayMs, exponential);
  // Full jitter: between 50% and 150% of the calculated exponential delay
  const jitterFactor = 0.5 + Math.random();
  return Math.floor(capped * jitterFactor);
}

/**
 * Executes an async operation with automated exponential backoff and jitter.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 10000;

  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await operation();
    } catch (error) {
      const isRetryable =
        options.shouldRetry?.(error, attempt) ??
        (StorageError.isStorageError(error) ? error.retryable : false);

      if (!isRetryable || attempt > maxRetries) {
        throw error;
      }

      const delay = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
