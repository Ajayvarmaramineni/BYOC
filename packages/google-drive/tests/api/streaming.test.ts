/**
 * Google Drive resumable streaming: the Content-Range protocol.
 *
 * Drive accepts `bytes {start}-{end}/*` while the total is unknown and requires
 * the real total on the final chunk. A chunk therefore cannot be classified
 * until we know whether more data follows, which is why the uploader keeps a
 * one-chunk lookahead. These tests pin the exact header sequence, because
 * getting it wrong fails at the *end* of a large upload rather than the start.
 *
 * The Python SDK asserts the same sequence in tests/test_gdrive_streaming.py.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResumableUploader } from "../../src/api/resumable.js";

const ALIGN = 256 * 1024;
const RANGE_RE = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/;

class TestUploader extends ResumableUploader {
  // Skip the real initiate call; the session URI is not what is under test.
  protected async initiateSession(): Promise<string> {
    return "https://upload.example/session";
  }
}

function driveFetch(seen: [string, number][]) {
  let received = 0;
  return vi.fn(async (_url: string, init: any) => {
    const raw = String(init.headers["Content-Range"]);
    const match = RANGE_RE.exec(raw);
    expect(match, `malformed Content-Range: ${raw}`).not.toBeNull();

    const [, start, end, total] = match!;
    const length = init.body ? (init.body as Uint8Array).byteLength : 0;
    seen.push([raw, length]);

    if (start !== undefined) {
      expect(Number(start), "chunks must be contiguous").toBe(received);
      expect(Number(end) - Number(start) + 1, "range must match body").toBe(length);
      if (total === "*") {
        expect(length % ALIGN, "a non-final chunk must be 256 KiB aligned").toBe(0);
      }
      received += length;
    }

    if (total === "*") {
      return {
        status: 308,
        headers: new Headers({ Range: `bytes=0-${received - 1}` })
      };
    }

    expect(Number(total), "final chunk must declare the real total").toBe(received);
    return {
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: "f1", name: "s.bin", size: String(received) })
    };
  });
}

async function stream(total: number, seen: [string, number][]): Promise<void> {
  const uploader = new TestUploader({ getAccessToken: async () => "token" } as never);
  async function* source(): AsyncGenerator<Uint8Array> {
    const step = 100_000; // deliberately not chunk-aligned
    for (let offset = 0; offset < total; offset += step) {
      yield new Uint8Array(Math.min(step, total - offset)).fill(100);
    }
  }
  await uploader.uploadStream({ name: "s.bin" }, source(), "application/octet-stream", ALIGN);
}

describe("Drive resumable streaming", () => {
  const originalFetch = global.fetch;
  let seen: [string, number][];

  beforeEach(() => {
    seen = [];
    global.fetch = driveFetch(seen) as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each([
    ["empty", 0, 1],
    ["one byte", 1, 1],
    ["just under one chunk", ALIGN - 1, 1],
    ["exactly one chunk", ALIGN, 1],
    ["exactly two chunks", ALIGN * 2, 2],
    ["two chunks plus one byte", ALIGN * 2 + 1, 3],
    ["many chunks, ragged tail", ALIGN * 7 + 12345, 8]
  ])("sends %s as the right number of chunks", async (_label, total, expected) => {
    await stream(total as number, seen);

    expect(seen.length).toBe(expected);
  });

  it("marks only the last chunk with a real total", async () => {
    await stream(ALIGN * 3 + 99, seen);

    const ranges = seen.map(([header]) => header);
    for (const header of ranges.slice(0, -1)) expect(header.endsWith("/*")).toBe(true);
    expect(ranges.at(-1)).toBe(`bytes ${ALIGN * 3}-${ALIGN * 3 + 98}/${ALIGN * 3 + 99}`);
  });

  it("sends a single full chunk as final, not as unknown-length", async () => {
    // The lookahead exists for exactly this case: a naive implementation ships
    // the full buffer as non-final and then has nothing left to finalise with.
    await stream(ALIGN, seen);

    expect(seen).toEqual([[`bytes 0-${ALIGN - 1}/${ALIGN}`, ALIGN]]);
  });

  it("finalises an empty stream without a byte range", async () => {
    await stream(0, seen);

    expect(seen).toEqual([["bytes */0", 0]]);
  });

  it("keeps offsets contiguous across chunks", async () => {
    await stream(ALIGN * 4 + 7, seen);

    let offset = 0;
    for (const [header, length] of seen) {
      expect(header.startsWith(`bytes ${offset}-`)).toBe(true);
      offset += length;
    }
    expect(offset).toBe(ALIGN * 4 + 7);
  });
});
