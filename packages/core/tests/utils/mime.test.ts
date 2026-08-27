import { describe, it, expect } from "vitest";
import { lookupMimeType } from "../../src/utils/mime.js";

describe("MIME Lookup Utility", () => {
  it("maps standard file extensions to proper MIME types", () => {
    expect(lookupMimeType("document.pdf")).toBe("application/pdf");
    expect(lookupMimeType("photos/avatar.png")).toBe("image/png");
    expect(lookupMimeType("photos/picture.jpeg")).toBe("image/jpeg");
    expect(lookupMimeType("data/stats.json")).toBe("application/json");
    expect(lookupMimeType("data/table.csv")).toBe("text/csv");
    expect(lookupMimeType("archive/backup.sql.gz")).toBe("application/gzip");
    expect(lookupMimeType("videos/lecture.mp4")).toBe("video/mp4");
  });

  it("handles case-insensitive extensions", () => {
    expect(lookupMimeType("PHOTO.JPG")).toBe("image/jpeg");
    expect(lookupMimeType("REPORT.PDF")).toBe("application/pdf");
  });

  it("falls back to application/octet-stream for unknown extensions or missing extensions", () => {
    expect(lookupMimeType("file-without-extension")).toBe("application/octet-stream");
    expect(lookupMimeType("file.unknownextension123")).toBe("application/octet-stream");
    expect(lookupMimeType("file.custom", "text/plain")).toBe("text/plain");
  });
});
