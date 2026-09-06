/**
 * A server that never sees your file.
 *
 * It does exactly two things: serve a page, and sign a short-lived permission
 * to write one object. The upload itself goes from the browser straight to the
 * storage account, so the bytes never enter this process.
 *
 * Every request is logged with its body size. That log is the point of the
 * demo: it shows a small POST for the grant, and then nothing at all while
 * hundreds of megabytes move.
 *
 *   npm install && npm start
 *
 * Defaults target a local MinIO, so no cloud account is needed:
 *   minio server /tmp/byoc-demo --address :9000
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { BYOC } from "@byoc/core";
import { S3CompatibleProvider } from "@byoc/s3-compatible";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const storage = new BYOC({
  provider: new S3CompatibleProvider({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    bucket: process.env.S3_BUCKET ?? "byoc-demo",
    region: process.env.S3_REGION ?? "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    forcePathStyle: true
  })
});
await storage.connect();

/** Bytes this process has received in request bodies, across its whole life. */
let bytesThroughServer = 0;

function log(method, url, bodyBytes) {
  bytesThroughServer += bodyBytes;
  const stamp = new Date().toISOString().slice(11, 19);
  const size = bodyBytes ? `${bodyBytes} B body` : "no body";
  console.log(
    `${stamp}  ${method.padEnd(4)} ${url.padEnd(34)} ${size.padStart(12)}   ` +
      `total through server: ${bytesThroughServer} B`
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Count anything a client tries to send us, so the log cannot flatter us.
  let bodyBytes = 0;
  req.on("data", (chunk) => (bodyBytes += chunk.length));
  await new Promise((resolve) => req.on("end", resolve));
  log(req.method, url.pathname, bodyBytes);

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(path.join(HERE, "public", "index.html")));
    return;
  }

  if (url.pathname === "/api/grant") {
    const name = url.searchParams.get("name");
    if (!name) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "name is required" }));
      return;
    }

    // In a real app this is where you check the caller may write here. A grant
    // is a bearer capability: whoever holds it can write to that one path until
    // it expires, so it must never be handed out unchecked.
    const grant = await storage.createUploadGrant(`demo/${name}`, {
      expiresInSeconds: 900
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(grant));
    return;
  }

  if (url.pathname === "/api/verify") {
    // Ask the provider what actually landed, so the demo proves arrival
    // rather than just showing a progress bar reach 100%.
    const name = url.searchParams.get("name");
    try {
      const meta = await storage.metadata(`demo/${name}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ size: meta.size, path: meta.path }));
    } catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`\n  BYOC direct-upload demo on http://localhost:${PORT}`);
  console.log("  Watch this log while you upload. It should stay quiet.\n");
});
