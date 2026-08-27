import { describe, it, expect } from "vitest";
import { buildMultipartBody, storageInputToUint8Array } from "../../src/api/multipart.js";
import { Readable } from "node:stream";

describe("Multipart Upload Payload Builder", () => {
  it("converts string, Uint8Array, Buffer, and Stream to Uint8Array", async () => {
    const fromStr = await storageInputToUint8Array("hello");
    expect(new TextDecoder().decode(fromStr)).toBe("hello");

    const fromBuf = await storageInputToUint8Array(Buffer.from("buffer data"));
    expect(new TextDecoder().decode(fromBuf)).toBe("buffer data");

    const fromStream = await storageInputToUint8Array(Readable.from(["stream ", "chunks"]));
    expect(new TextDecoder().decode(fromStream)).toBe("stream chunks");
  });

  it("constructs valid multipart/related payload with boundary and headers", async () => {
    const metadata = { name: "test-file.txt", parents: ["folder123"] };
    const content = "Hello Google Drive from BYOC!";
    const mimeType = "text/plain";

    const payload = await buildMultipartBody(metadata, content, mimeType);

    expect(payload.contentType).toMatch(/^multipart\/related; boundary=-------BYOC_BOUNDARY_/);
    expect(payload.body).toBeInstanceOf(Uint8Array);

    const bodyText = new TextDecoder().decode(payload.body);
    expect(bodyText).toContain('Content-Type: application/json; charset=UTF-8');
    expect(bodyText).toContain('"name":"test-file.txt"');
    expect(bodyText).toContain('"parents":["folder123"]');
    expect(bodyText).toContain('Content-Type: text/plain');
    expect(bodyText).toContain('Hello Google Drive from BYOC!');
  });
});
