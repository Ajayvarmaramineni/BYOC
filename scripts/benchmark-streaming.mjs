import crypto from "node:crypto";

import { E2EECrypto } from "../packages/core/dist/index.js";

const totalMiB = Number(process.argv[2] ?? 256);
const frameKiB = Number(process.argv[3] ?? 256);
if (!Number.isInteger(totalMiB) || totalMiB < 1) {
  throw new Error("totalMiB must be a positive integer");
}
if (!Number.isInteger(frameKiB) || frameKiB < 4 || frameKiB > 8192) {
  throw new Error("frameKiB must be an integer between 4 and 8192");
}

const totalBytes = totalMiB * 1024 * 1024;
const sourceChunkBytes = 64 * 1024;
const expected = crypto.createHash("sha256");
const actual = crypto.createHash("sha256");
const e2ee = new E2EECrypto({
  passphrase: "byoc-repeatable-stream-benchmark",
  keyDerivationIterations: 10_000,
  frameSize: frameKiB * 1024
});

global.gc?.();
const baselineRss = process.memoryUsage().rss;
let peakRss = baselineRss;
let processed = 0;
const started = performance.now();

async function* source() {
  const chunks = Math.ceil(totalBytes / sourceChunkBytes);
  for (let index = 0; index < chunks; index += 1) {
    const length = Math.min(sourceChunkBytes, totalBytes - index * sourceChunkBytes);
    const chunk = Buffer.alloc(length, index % 251);
    expected.update(chunk);
    yield chunk;
  }
}

for await (const chunk of e2ee.decryptStream(e2ee.encryptStream(source()))) {
  actual.update(chunk);
  processed += chunk.byteLength;
  if (processed % (8 * 1024 * 1024) === 0) global.gc?.();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

const expectedHash = expected.digest("hex");
const actualHash = actual.digest("hex");
if (actualHash !== expectedHash) {
  throw new Error("streaming benchmark failed: plaintext hash mismatch");
}

console.log(JSON.stringify({
  bytes: processed,
  frameKiB,
  sourceChunkKiB: sourceChunkBytes / 1024,
  sha256: actualHash,
  elapsedMs: Math.round(performance.now() - started),
  peakRssDeltaMiB: Math.round((peakRss - baselineRss) / 1024 / 1024)
}, null, 2));
