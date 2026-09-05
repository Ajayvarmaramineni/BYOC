import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { S3CompatibleProvider } from "../src/adapter.js";
import { BYOCErrorCode, StorageError } from "@byoc/core";

describe("S3CompatibleProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const validConfig = {
    endpoint: "https://my-account-id.r2.cloudflarestorage.com",
    bucket: "user-assets",
    region: "auto",
    accessKeyId: "mock-access-key",
    secretAccessKey: "mock-secret-key",
    rootPrefix: "production/data"
  };

  it("instantiates correctly and declares developer-cloud category", () => {
    const provider = new S3CompatibleProvider(validConfig);
    const manifest = provider.manifest();

    expect(manifest.id).toBe("s3-compatible");
    expect(manifest.category).toBe("developer-cloud");
    expect(manifest.authentication).toBe("access-key");
    expect(provider.capabilities().publicUrls).toBe(true);
  });

  it("throws INVALID_INPUT on missing required credentials", () => {
    expect(() => new S3CompatibleProvider({} as any)).toThrowError(StorageError);
  });

  it("signs and sends PUT Object request for upload with auto-path-style for R2", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"mock-md5-checksum"' })
    });

    const result = await provider.upload("users/123/avatar.png", "PNG Data", { mimeType: "image/png" });

    expect(result.id).toContain("s3_user-assets_production/data/users/123/avatar.png");
    expect(result.path).toBe("users/123/avatar.png"); // Assert virtual path encapsulation (no physical prefix leak)
    expect(result.checksum).toBe("mock-md5-checksum");

    // Path-style addressing includes /user-assets/ in URL
    expect(global.fetch).toHaveBeenCalledWith(
      "https://my-account-id.r2.cloudflarestorage.com/user-assets/production/data/users/123/avatar.png",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("AWS4-HMAC-SHA256")
        })
      })
    );
  });

  it("uses UNSIGNED-PAYLOAD for a streaming PUT instead of signing an empty body", async () => {
    const provider = new S3CompatibleProvider(validConfig);
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"stream-etag"' })
    });

    await provider.upload("large/archive.bin", Readable.from([Buffer.from("chunk")]), {
      contentLength: 5
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("large/archive.bin"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "content-length": "5",
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD"
        })
      })
    );
  });

  it("sends an unknown-length stream as a multipart upload", async () => {
    // S3 answers 411 Length Required to a chunked PUT, so a stream whose size
    // is not known up front cannot go in a single request. Multipart is the
    // way round it: each part carries its own Content-Length.
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any)
      // 1. initiate
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>"
      })
      // 2. the single part
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"part-etag"' }),
        text: async () => ""
      })
      // 3. complete
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          "<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag></CompleteMultipartUploadResult>"
      });

    const result = await provider.upload(
      "large/unknown.bin",
      Readable.from([Buffer.from("chunk")])
    );

    expect(result.size).toBe(5);

    const urls = (global.fetch as any).mock.calls.map(([url]: [string]) => String(url));
    expect(urls[0]).toContain("uploads=");
    expect(urls[1]).toContain("partNumber=1");
    expect(urls[1]).toContain("uploadId=upload-1");
    expect(urls[2]).toContain("uploadId=upload-1");
  });

  it("aborts the multipart upload when a part fails, so parts stop accruing cost", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          "<InitiateMultipartUploadResult><UploadId>upload-2</UploadId></InitiateMultipartUploadResult>"
      })
      // Every retry of the part fails.
      .mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => "AccessDenied"
      });

    await expect(
      provider.upload("large/fails.bin", Readable.from([Buffer.from("chunk")]))
    ).rejects.toThrow();

    const calls = (global.fetch as any).mock.calls;
    const aborted = calls.some(
      ([url, init]: [string, any]) =>
        init?.method === "DELETE" && String(url).includes("uploadId=upload-2")
    );
    expect(aborted, "a failed multipart upload must be aborted").toBe(true);
  });

  it("handles AWS S3 standard endpoint path-style addressing when bucket is not in hostname", () => {
    const awsProvider = new S3CompatibleProvider({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      bucket: "my-corporate-bucket",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret"
    });

    const url = awsProvider.http.getObjectUrl("reports/2026#1?data.pdf");
    expect(url).toBe("https://s3.us-east-1.amazonaws.com/my-corporate-bucket/reports/2026%231%3Fdata.pdf");
  });

  it("downloads object and returns text", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain", "content-length": "12" }),
      text: async () => "Hello S3/R2!",
      arrayBuffer: async () => new TextEncoder().encode("Hello S3/R2!").buffer
    });

    const output = await provider.download("notes.txt");
    const text = await output.text();
    expect(text).toBe("Hello S3/R2!");
  });

  it("executes instant server-side copy using x-amz-copy-source", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200
    });

    await provider.copy("docs/source.pdf", "docs/backup.pdf");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://my-account-id.r2.cloudflarestorage.com/user-assets/production/data/docs/backup.pdf",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "x-amz-copy-source": "/user-assets/production/data/docs/source.pdf"
        })
      })
    );
  });

  it("executes server-side move (copy + delete)", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any)
      .mockResolvedValueOnce({ ok: true, status: 200 }) // copy
      .mockResolvedValueOnce({ ok: true, status: 204 }); // delete

    await provider.move("docs/old.pdf", "docs/new.pdf");

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("generates SigV4 presigned download URLs", () => {
    const provider = new S3CompatibleProvider(validConfig);
    const presignedUrl = provider.getSignedUrl("reports/annual.pdf", { expiresInSeconds: 1800 });

    expect(presignedUrl).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(presignedUrl).toContain("X-Amz-Expires=1800");
    expect(presignedUrl).toContain("X-Amz-Signature=");
  });

  it("maps 404 response to OBJECT_NOT_FOUND", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "<Error><Code>NoSuchKey</Code></Error>"
    });

    await expect(provider.download("missing.txt")).rejects.toThrowError(
      expect.objectContaining({
        code: BYOCErrorCode.OBJECT_NOT_FOUND
      })
    );
  });

  it("lists files and folder prefixes using ListObjectsV2 with pagination", async () => {
    const provider = new S3CompatibleProvider(validConfig);

    const mockXmlPage1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>user-assets</Name>
    <Prefix>production/data/</Prefix>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>token-page-2</NextContinuationToken>
    <Contents>
        <Key>production/data/document1.pdf</Key>
        <Size>4096</Size>
    </Contents>
</ListBucketResult>`;

    const mockXmlPage2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>user-assets</Name>
    <Prefix>production/data/</Prefix>
    <IsTruncated>false</IsTruncated>
    <Contents>
        <Key>production/data/document2.pdf</Key>
        <Size>8192</Size>
    </Contents>
    <CommonPrefixes>
        <Prefix>production/data/photos/</Prefix>
    </CommonPrefixes>
</ListBucketResult>`;

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockXmlPage1
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => mockXmlPage2
      });

    const items = await provider.list();
    expect(items.length).toBe(3); // 2 files + 1 folder across 2 paginated requests

    const folder = items.find((i) => i.type === "folder");
    const file1 = items.find((i) => i.name === "document1.pdf");
    const file2 = items.find((i) => i.name === "document2.pdf");

    expect(folder?.name).toBe("photos");
    expect(folder?.path).toBe("photos"); // virtual path
    expect(file1?.path).toBe("document1.pdf"); // virtual path
    expect(file2?.path).toBe("document2.pdf"); // virtual path
    expect(file2?.size).toBe(8192);
  });

  describe("copy source encoding", () => {
    /**
     * Regression: `copyObject` built the `x-amz-copy-source` header with
     * `encodeURI`, which leaves `#` and `?` intact. S3 then read the header as
     * a URL and truncated the key at those characters, so copying
     * `draft#2.pdf` asked for `draft` and reported the object missing.
     * The header must follow the same per-segment RFC 3986 rule as the
     * object URL. Confirmed against a live MinIO server.
     */
    it.each([
      ["reports/draft#2.pdf", "reports/draft%232.pdf"],
      ["reports/q?x.txt", "reports/q%3Fx.txt"],
      ["reports/sp ace.txt", "reports/sp%20ace.txt"],
      ["reports/a+b.txt", "reports/a%2Bb.txt"],
      ["reports/100%.txt", "reports/100%25.txt"]
    ])("percent-encodes %s in x-amz-copy-source", async (source, expectedKey) => {
      const provider = new S3CompatibleProvider(validConfig);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => ""
      });

      await provider.copy(source, "reports/destination.pdf");

      const [, init] = (global.fetch as any).mock.calls[0];
      const copySource = new Headers(init.headers).get("x-amz-copy-source");

      expect(copySource).toBe(
        `/${validConfig.bucket}/${validConfig.rootPrefix}/${expectedKey}`
      );
      // The bug was that these survived unescaped and truncated the key.
      expect(copySource).not.toContain("#");
      expect(copySource).not.toContain("?");
    });

    it("keeps path separators unescaped so the key stays a path", async () => {
      const provider = new S3CompatibleProvider(validConfig);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => ""
      });

      await provider.copy("a/b/c.txt", "a/b/d.txt");

      const [, init] = (global.fetch as any).mock.calls[0];
      const copySource = new Headers(init.headers).get("x-amz-copy-source");

      expect(copySource).toBe("/user-assets/production/data/a/b/c.txt");
      expect(copySource).not.toContain("%2F");
    });
  });
});
