import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { WebDAVProvider } from "../src/adapter.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("WebDAVProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const validConfig = {
    endpoint: "https://nextcloud.mycompany.com/remote.php/dav/files/user/",
    username: "john_doe",
    password: "app-password-xyz",
    rootFolder: "MyApp"
  };

  it("declares self-hosted category and standard capabilities", () => {
    const provider = new WebDAVProvider(validConfig);
    const manifest = provider.manifest();

    expect(manifest.id).toBe("webdav");
    expect(manifest.category).toBe("self-hosted");
    expect(manifest.authentication).toBe("basic");
    expect(provider.capabilities().folders).toBe(true);
    expect(provider.capabilities().quota).toBe(true);
    expect(provider.capabilities().serverSideCopy).toBe(true);
  });

  it("throws INVALID_INPUT when endpoint is omitted", () => {
    expect(() => new WebDAVProvider({} as any)).toThrowError(StorageError);
  });

  it("uploads file to WebDAV server using HTTP PUT with Basic Auth", async () => {
    const provider = new WebDAVProvider(validConfig);

    // 1. MKCOL for root folder MyApp
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 2. MKCOL for parent folder MyApp/documents
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 3. PUT file
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Headers({ etag: '"etag-webdav-123"' })
    });

    const result = await provider.upload("documents/notes.txt", "WebDAV content");

    expect(result.id).toBe("webdav_MyApp/documents/notes.txt");
    expect(result.path).toBe("documents/notes.txt"); // Virtual path (does not leak MyApp/)
    expect(result.checksum).toBe("etag-webdav-123");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://nextcloud.mycompany.com/remote.php/dav/files/user/MyApp/documents/notes.txt",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Basic ")
        })
      })
    );
  });

  it("sends a declared content length for streaming PUTs", async () => {
    const provider = new WebDAVProvider({ ...validConfig, rootFolder: "" });
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 207, text: async () => "" });
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Headers({ etag: '"stream-etag"' })
    });

    await provider.upload("stream.bin", Readable.from([Buffer.from("chunk")]), {
      contentLength: 5
    });

    expect(global.fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("stream.bin"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "Content-Length": "5" })
      })
    );
  });

  it("executes server-side COPY with Destination and Overwrite headers", async () => {
    const provider = new WebDAVProvider(validConfig);

    // 1. MKCOL for parent folder MyApp
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 2. MKCOL for parent folder MyApp/docs
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 3. COPY operation
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });

    await provider.copy("docs/source.pdf", "docs/copy.pdf");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://nextcloud.mycompany.com/remote.php/dav/files/user/MyApp/docs/source.pdf",
      expect.objectContaining({
        method: "COPY",
        headers: expect.objectContaining({
          Destination: "https://nextcloud.mycompany.com/remote.php/dav/files/user/MyApp/docs/copy.pdf",
          Overwrite: "T"
        })
      })
    );
  });

  it("executes server-side MOVE with Destination header", async () => {
    const provider = new WebDAVProvider(validConfig);

    // 1. MKCOL for parent folder MyApp
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 2. MKCOL for parent folder MyApp/archive
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });
    // 3. MOVE operation
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 201 });

    await provider.move("docs/old.pdf", "archive/new.pdf");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://nextcloud.mycompany.com/remote.php/dav/files/user/MyApp/docs/old.pdf",
      expect.objectContaining({
        method: "MOVE",
        headers: expect.objectContaining({
          Destination: "https://nextcloud.mycompany.com/remote.php/dav/files/user/MyApp/archive/new.pdf"
        })
      })
    );
  });

  it("queries RFC 4331 storage quota via PROPFIND Depth: 0", async () => {
    const provider = new WebDAVProvider(validConfig);

    const mockQuotaXml = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/user/MyApp/</d:href>
    <d:propstat>
      <d:prop>
        <d:quota-available-bytes>53687091200</d:quota-available-bytes>
        <d:quota-used-bytes>10737418240</d:quota-used-bytes>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 207,
      text: async () => mockQuotaXml
    });

    const quota = await provider.quota();
    expect(quota.used).toBe(10737418240); // 10 GB
    expect(quota.available).toBe(53687091200); // 50 GB
    expect(quota.total).toBe(64424509440); // 60 GB
  });

  it("maps 404 to OBJECT_NOT_FOUND", async () => {
    const provider = new WebDAVProvider(validConfig);

    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "File Not Found"
    });

    await expect(provider.download("missing.txt")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.OBJECT_NOT_FOUND
      })
    );
  });

  it("lists files and folders using PROPFIND XML", async () => {
    const provider = new WebDAVProvider(validConfig);

    const mockXml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
    <d:response>
        <d:href>/remote.php/dav/files/user/MyApp/</d:href>
        <d:propstat>
            <d:prop>
                <d:resourcetype><d:collection/></d:resourcetype>
            </d:prop>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/user/MyApp/report.pdf</d:href>
        <d:propstat>
            <d:prop>
                <d:getcontentlength>8192</d:getcontentlength>
                <d:getcontenttype>application/pdf</d:getcontenttype>
                <d:getetag>"etag-report-456"</d:getetag>
                <d:resourcetype/>
            </d:prop>
        </d:propstat>
    </d:response>
    <d:response>
        <d:href>/remote.php/dav/files/user/MyApp/Archive/</d:href>
        <d:propstat>
            <d:prop>
                <d:resourcetype><d:collection/></d:resourcetype>
            </d:prop>
        </d:propstat>
    </d:response>
</d:multistatus>`;

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 207,
      text: async () => mockXml
    });

    const items = await provider.list();
    expect(items.length).toBe(2);

    const file = items.find((i) => i.type === "file");
    const folder = items.find((i) => i.type === "folder");

    expect(file?.name).toBe("report.pdf");
    expect(file?.path).toBe("report.pdf"); // virtual path
    expect(file?.size).toBe(8192);
    expect(file?.mimeType).toBe("application/pdf");

    expect(folder?.name).toBe("Archive");
    expect(folder?.path).toBe("Archive"); // virtual path
  });
});
