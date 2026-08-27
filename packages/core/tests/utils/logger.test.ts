import { describe, it, expect, vi } from "vitest";
import { SafeLogger, SilentLogger, sanitizeLogValue } from "../../src/utils/logger.js";

describe("SafeLogger & Secret Redaction", () => {
  it("redacts Bearer tokens and Google ya29 tokens in strings", () => {
    const rawMsg = "Connecting with Bearer ya29.a0AfH6SMAxyz123 to Google Drive";
    const clean = sanitizeLogValue(rawMsg) as string;

    expect(clean).not.toContain("ya29");
    expect(clean).not.toContain("ya29.a0AfH6SMAxyz123");
    expect(clean).toContain("[REDACTED_SECRET]");
  });

  it("redacts sensitive fields in nested objects", () => {
    const payload = {
      user: "alice",
      auth: {
        accessToken: "secret-token-abc",
        refreshToken: "secret-refresh-xyz",
        clientSecret: "top-secret-val"
      },
      file: "report.pdf"
    };

    const sanitized = sanitizeLogValue(payload) as any;
    expect(sanitized.user).toBe("alice");
    expect(sanitized.file).toBe("report.pdf");
    expect(sanitized.auth.accessToken).toBe("[REDACTED_SECRET]");
    expect(sanitized.auth.refreshToken).toBe("[REDACTED_SECRET]");
    expect(sanitized.auth.clientSecret).toBe("[REDACTED_SECRET]");
  });

  it("SafeLogger outputs scrubbed messages to console methods", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const logger = new SafeLogger("info");
    logger.info("Upload with token ya29.a0AfH6SMAxyz");

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[BYOC INFO] Upload with token [REDACTED_SECRET]")
    );

    infoSpy.mockRestore();
  });

  it("SilentLogger suppresses all logs", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new SilentLogger();
    logger.error("Something went wrong");

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
