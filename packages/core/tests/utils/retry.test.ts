import { describe, it, expect, vi } from "vitest";
import { withRetry, calculateBackoffDelay } from "../../src/utils/retry.js";
import { StorageError } from "../../src/errors/storage-error.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";

describe("Retry Utility", () => {
  describe("calculateBackoffDelay", () => {
    it("scales delay with exponential attempts and stays within jitter range", () => {
      const delay1 = calculateBackoffDelay(1, 100, 10000);
      expect(delay1).toBeGreaterThanOrEqual(50); // 100 * 0.5
      expect(delay1).toBeLessThanOrEqual(150); // 100 * 1.5

      const delay3 = calculateBackoffDelay(3, 100, 10000);
      expect(delay3).toBeGreaterThanOrEqual(200); // 400 * 0.5
      expect(delay3).toBeLessThanOrEqual(600); // 400 * 1.5
    });

    it("respects maxDelay cap", () => {
      const delayCapped = calculateBackoffDelay(10, 1000, 2000);
      expect(delayCapped).toBeLessThanOrEqual(3000); // 2000 * 1.5 max jitter
    });
  });

  describe("withRetry", () => {
    it("returns result immediately on successful execution without retry", async () => {
      const op = vi.fn().mockResolvedValue("success");
      const result = await withRetry(op);
      expect(result).toBe("success");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries on retryable StorageError up to maxRetries", async () => {
      const retryableError = new StorageError({
        code: BYOCErrorCode.RATE_LIMITED,
        message: "Throttled",
        provider: "mock",
        retryable: true
      });

      const op = vi
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue("eventual success");

      const result = await withRetry(op, {
        maxRetries: 3,
        baseDelayMs: 5,
        maxDelayMs: 20
      });

      expect(result).toBe("eventual success");
      expect(op).toHaveBeenCalledTimes(3);
    });

    it("fails immediately on non-retryable StorageError without retrying", async () => {
      const nonRetryableError = new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "Invalid token",
        provider: "mock",
        retryable: false
      });

      const op = vi.fn().mockRejectedValue(nonRetryableError);

      await expect(
        withRetry(op, {
          maxRetries: 3,
          baseDelayMs: 5
        })
      ).rejects.toThrow(nonRetryableError);

      expect(op).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting maxRetries", async () => {
      const retryableError = new StorageError({
        code: BYOCErrorCode.PROVIDER_UNAVAILABLE,
        message: "Backend 503",
        provider: "mock",
        retryable: true
      });

      const op = vi.fn().mockRejectedValue(retryableError);

      await expect(
        withRetry(op, {
          maxRetries: 2,
          baseDelayMs: 5
        })
      ).rejects.toThrow(retryableError);

      expect(op).toHaveBeenCalledTimes(3); // Initial attempt + 2 retries
    });
  });
});
