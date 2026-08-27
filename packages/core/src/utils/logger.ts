export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface BYOCLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-\.]+/gi,
  /ya29\.[A-Za-z0-9_\-\.]+/gi,
  /("?(?:access_token|refresh_token|client_secret|apiKey|secret|authorization)"?\s*[:=]\s*"?[^",\s}]+"?)/gi
];

/**
 * Recursively sanitizes strings and objects to prevent credential/token leakage.
 */
export function sanitizeLogValue(val: unknown): unknown {
  if (typeof val === "string") {
    let sanitized = val;
    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED_SECRET]");
    }
    return sanitized;
  }

  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      return val.map(sanitizeLogValue);
    }
    if (val instanceof Error) {
      return {
        name: val.name,
        message: sanitizeLogValue(val.message),
        stack: val.stack ? sanitizeLogValue(val.stack) : undefined
      };
    }
    const cleanObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("authorization")
      ) {
        cleanObj[k] = "[REDACTED_SECRET]";
      } else {
        cleanObj[k] = sanitizeLogValue(v);
      }
    }
    return cleanObj;
  }

  return val;
}

/**
 * SafeLogger — Wraps console logging with zero-token redaction.
 */
export class SafeLogger implements BYOCLogger {
  constructor(private readonly level: LogLevel = "info") {}

  public debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      console.debug(`[BYOC DEBUG] ${sanitizeLogValue(message)}`, ...args.map(sanitizeLogValue));
    }
  }

  public info(message: string, ...args: unknown[]): void {
    if (this.shouldLog("info")) {
      console.info(`[BYOC INFO] ${sanitizeLogValue(message)}`, ...args.map(sanitizeLogValue));
    }
  }

  public warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      console.warn(`[BYOC WARN] ${sanitizeLogValue(message)}`, ...args.map(sanitizeLogValue));
    }
  }

  public error(message: string, ...args: unknown[]): void {
    if (this.shouldLog("error")) {
      console.error(`[BYOC ERROR] ${sanitizeLogValue(message)}`, ...args.map(sanitizeLogValue));
    }
  }

  private shouldLog(targetLevel: LogLevel): boolean {
    if (this.level === "silent") return false;
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(targetLevel) >= levels.indexOf(this.level);
  }
}

/**
 * SilentLogger — Disables all console output.
 */
export class SilentLogger implements BYOCLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
