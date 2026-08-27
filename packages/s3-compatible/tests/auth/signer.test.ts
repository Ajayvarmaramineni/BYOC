import { describe, it, expect } from "vitest";
import { signS3Request, buildCanonicalQueryString, createPresignedS3Url } from "../../src/auth/signer.js";

describe("AWS SigV4 Signer & Canonicalization", () => {
  const options = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3"
  };

  const fixedDate = new Date("2026-08-25T00:00:00.000Z");

  it("matches the exact signature for AWS SigV4 reference vectors", () => {
    // Official AWS Reference Parameters
    const awsOptions = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3"
    };

    const awsDate = new Date("2013-05-24T00:00:00.000Z");
    const signed = signS3Request(awsOptions, {
      method: "GET",
      url: "https://example.amazonaws.com/test.txt",
      headers: {
        "x-amz-storage-class": "REDUCED_REDUNDANCY"
      },
      datetime: awsDate
    });

    expect(signed["x-amz-date"]).toBe("20130524T000000Z");
    expect(signed["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(signed.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=c29c0c4b3f775eacb23837eb912405953619018f2417926a9ed48e32352e0e3b"
    );
  });

  it("produces identical signatures regardless of header casing (Bug #3 fix)", () => {
    const url = "https://examplebucket.s3.amazonaws.com/test.txt";

    const signedWithUpper = signS3Request(options, {
      method: "PUT",
      url,
      headers: { "Content-Type": "application/json", "X-Amz-Meta-Author": "Alice" },
      body: '{"status":"ok"}',
      datetime: fixedDate
    });

    const signedWithLower = signS3Request(options, {
      method: "PUT",
      url,
      headers: { "content-type": "application/json", "x-amz-meta-author": "Alice" },
      body: '{"status":"ok"}',
      datetime: fixedDate
    });

    expect(signedWithUpper.Authorization).toBe(signedWithLower.Authorization);
    expect(signedWithUpper.Authorization).toContain("content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-author");
  });

  it("correctly encodes and sorts multi-parameter query strings with %20 (Bug #4 fix)", () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/?prefix=my+folder&list-type=2&delimiter=%2F");
    const canonicalQuery = buildCanonicalQueryString(url);

    // Must be sorted alphabetically by key: delimiter -> list-type -> prefix
    // And spaces encoded as %20
    expect(canonicalQuery).toBe("delimiter=%2F&list-type=2&prefix=my%20folder");
  });

  it("handles complex S3 ListObjectsV2 query signing", () => {
    const url = "https://my-bucket.s3.us-east-1.amazonaws.com/?list-type=2&prefix=photos%2F2026%2F&delimiter=%2F&max-keys=100";

    const signed = signS3Request(options, {
      method: "GET",
      url,
      datetime: fixedDate
    });

    expect(signed.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260825\/us-east-1\/s3\/aws4_request/);
    expect(signed.Authorization).toContain("Signature=");
  });

  it("generates valid presigned URL query parameters with AWS4-HMAC-SHA256", () => {
    const url = "https://examplebucket.s3.us-east-1.amazonaws.com/report.pdf";
    const presigned = createPresignedS3Url(options, url, {
      expiresInSeconds: 3600,
      datetime: fixedDate
    });

    const parsed = new URL(presigned);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20260825/us-east-1/s3/aws4_request");
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260825T000000Z");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
