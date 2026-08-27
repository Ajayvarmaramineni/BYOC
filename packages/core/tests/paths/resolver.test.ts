import { describe, it, expect } from "vitest";
import {
  normalizeVirtualPath,
  getBasename,
  getDirname,
  splitPath
} from "../../src/paths/resolver.js";
import { BYOCErrorCode } from "../../src/errors/codes.js";
import { StorageError } from "../../src/errors/storage-error.js";

describe("Virtual Path Resolver", () => {
  describe("normalizeVirtualPath", () => {
    it("returns empty string for undefined or empty paths", () => {
      expect(normalizeVirtualPath()).toBe("");
      expect(normalizeVirtualPath("")).toBe("");
      expect(normalizeVirtualPath("   ")).toBe("");
    });

    it("normalizes simple paths", () => {
      expect(normalizeVirtualPath("avatar.jpg")).toBe("avatar.jpg");
      expect(normalizeVirtualPath("users/123/avatar.jpg")).toBe("users/123/avatar.jpg");
    });

    it("strips leading and trailing slashes and whitespace", () => {
      expect(normalizeVirtualPath("/users/123/avatar.jpg/")).toBe("users/123/avatar.jpg");
      expect(normalizeVirtualPath("  /documents/report.pdf  ")).toBe("documents/report.pdf");
    });

    it("collapses duplicate consecutive slashes", () => {
      expect(normalizeVirtualPath("users///123////avatar.jpg")).toBe("users/123/avatar.jpg");
      expect(normalizeVirtualPath("///a//b///c//")).toBe("a/b/c");
    });

    it("converts Windows backslashes to forward slashes", () => {
      expect(normalizeVirtualPath("users\\123\\avatar.jpg")).toBe("users/123/avatar.jpg");
      expect(normalizeVirtualPath("\\users\\123\\")).toBe("users/123");
    });

    it("ignores current directory dot segments ('.')", () => {
      expect(normalizeVirtualPath("./users/./123/avatar.jpg")).toBe("users/123/avatar.jpg");
    });

    it("throws StorageError with INVALID_INPUT for directory traversal attempts", () => {
      expect(() => normalizeVirtualPath("../secret.txt")).toThrowError(StorageError);

      try {
        normalizeVirtualPath("users/../../etc/passwd");
      } catch (err) {
        expect(StorageError.isStorageError(err)).toBe(true);
        if (StorageError.isStorageError(err)) {
          expect(err.code).toBe(BYOCErrorCode.INVALID_INPUT);
        }
      }
    });

    it("strips NUL bytes and control characters (Bug #8 fix)", () => {
      expect(normalizeVirtualPath("a/bad\u0000name.txt")).toBe("a/badname.txt");
      expect(normalizeVirtualPath("documents/\nreport\r.pdf")).toBe("documents/report.pdf");
      expect(normalizeVirtualPath("\x07system/\x1Fdata.bin")).toBe("system/data.bin");
    });
  });

  describe("getBasename", () => {
    it("returns the filename or last path component", () => {
      expect(getBasename("users/123/avatar.jpg")).toBe("avatar.jpg");
      expect(getBasename("/documents/reports/q3.pdf/")).toBe("q3.pdf");
      expect(getBasename("single_file.txt")).toBe("single_file.txt");
      expect(getBasename("")).toBe("");
    });
  });

  describe("getDirname", () => {
    it("returns the parent directory path", () => {
      expect(getDirname("users/123/avatar.jpg")).toBe("users/123");
      expect(getDirname("avatar.jpg")).toBe("");
      expect(getDirname("/a/b/c/d.txt")).toBe("a/b/c");
    });
  });

  describe("splitPath", () => {
    it("splits path into segments", () => {
      expect(splitPath("users/123/avatar.jpg")).toEqual(["users", "123", "avatar.jpg"]);
      expect(splitPath("avatar.jpg")).toEqual(["avatar.jpg"]);
      expect(splitPath("")).toEqual([]);
    });
  });
});
