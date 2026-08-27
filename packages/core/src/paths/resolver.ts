import { BYOCErrorCode } from "../errors/codes.js";
import { StorageError } from "../errors/storage-error.js";

/**
 * Normalizes a virtual path:
 * - Converts backslashes to forward slashes.
 * - Collapses multiple consecutive slashes (e.g. "a///b/c" -> "a/b/c").
 * - Trims leading and trailing slashes and whitespace.
 * - Disallows directory traversal sequences (e.g. "../", "..").
 *
 * @param rawPath The input path provided by the developer
 * @returns Clean normalized POSIX path (e.g. "users/123/avatar.jpg" or "" for root)
 * @throws StorageError with BYOC_INVALID_INPUT if traversal is detected
 */
export function normalizeVirtualPath(rawPath?: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    return "";
  }

  // Trim whitespace, strip control characters (NUL, newlines, etc.), and replace Windows backslashes
  let path = rawPath.replace(/[\x00-\x1F\x7F]/g, "").trim().replace(/\\/g, "/");

  // Collapse consecutive slashes
  path = path.replace(/\/+/g, "/");

  // Remove leading and trailing slashes
  path = path.replace(/^\/+|\/+$/g, "");

  if (!path) {
    return "";
  }

  // Split into segments and validate each segment
  const segments = path.split("/");
  const cleanSegments: string[] = [];

  for (const segment of segments) {
    const trimmed = segment.trim();

    if (trimmed === "" || trimmed === ".") {
      continue;
    }

    if (trimmed === "..") {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: `Invalid virtual path "${rawPath}": Directory traversal ("..") is forbidden.`,
        provider: "core",
        retryable: false
      });
    }

    cleanSegments.push(trimmed);
  }

  return cleanSegments.join("/");
}

/**
 * Extracts the file or folder name from a normalized path.
 * e.g. "users/123/avatar.jpg" -> "avatar.jpg"
 */
export function getBasename(path: string): string {
  const normalized = normalizeVirtualPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

/**
 * Extracts the parent directory path from a normalized path.
 * e.g. "users/123/avatar.jpg" -> "users/123"
 */
export function getDirname(path: string): string {
  const normalized = normalizeVirtualPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

/**
 * Splits a normalized path into its constituent directory/file segments.
 * e.g. "users/123/avatar.jpg" -> ["users", "123", "avatar.jpg"]
 */
export function splitPath(path: string): string[] {
  const normalized = normalizeVirtualPath(path);
  return normalized ? normalized.split("/") : [];
}

/**
 * Encodes a URI string according to RFC 3986 (converting ! ' ( ) * to hex).
 */
export function rfc3986UriEncode(str: string, encodeSlash: boolean = false): string {
  let result = encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!encodeSlash) {
    result = result.replace(/%2F/g, "/");
  }
  return result;
}

/**
 * Encodes individual path segments according to RFC 3986, preserving forward slashes.
 * Safely encodes #, ?, +, &, spaces and unicode without breaking POSIX path hierarchies.
 */
export function encodePathSegments(path: string): string {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  if (!cleanPath) return "";
  return cleanPath
    .split("/")
    .map((segment) => rfc3986UriEncode(segment, true))
    .join("/");
}

