#!/usr/bin/env node
/**
 * TypeScript half of the cross-SDK interop suite.
 *
 * The Python suite shells out to this script so both SDKs act on the *same*
 * live storage server in one test run. Every command reads JSON on argv and
 * prints JSON on stdout, so the Python side never parses prose.
 *
 * Usage: node interop_cli.mjs <command> '<json-args>'
 */

const [, , command, rawArgs] = process.argv;
const args = rawArgs ? JSON.parse(rawArgs) : {};

const repoRoot = new URL("../../../", import.meta.url).pathname;
const load = (pkg) => import(`${repoRoot}packages/${pkg}/dist/index.js`);

const env = {
  s3Endpoint: process.env.BYOC_TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  s3Bucket: process.env.BYOC_TEST_S3_BUCKET ?? "byoc-integration",
  s3Region: process.env.BYOC_TEST_S3_REGION ?? "us-east-1",
  s3Key: process.env.BYOC_TEST_S3_ACCESS_KEY ?? "minioadmin",
  s3Secret: process.env.BYOC_TEST_S3_SECRET_KEY ?? "minioadmin",
  davEndpoint: process.env.BYOC_TEST_WEBDAV_ENDPOINT ?? "http://127.0.0.1:8099",
  davUser: process.env.BYOC_TEST_WEBDAV_USERNAME ?? "byoc",
  davPassword: process.env.BYOC_TEST_WEBDAV_PASSWORD ?? "byoc-secret"
};

async function s3Provider(rootPrefix) {
  const { S3CompatibleProvider } = await load("s3-compatible");
  return new S3CompatibleProvider({
    endpoint: env.s3Endpoint,
    bucket: env.s3Bucket,
    region: env.s3Region,
    accessKeyId: env.s3Key,
    secretAccessKey: env.s3Secret,
    rootPrefix,
    forcePathStyle: true
  });
}

async function davProvider(rootFolder) {
  const { WebDAVProvider } = await load("webdav");
  const provider = new WebDAVProvider({
    endpoint: env.davEndpoint,
    username: env.davUser,
    password: env.davPassword,
    rootFolder
  });
  await provider.connect();
  return provider;
}

const commands = {
  // --- storage round-trips ------------------------------------------------

  async write({ backend, root, files }) {
    const provider = backend === "s3" ? await s3Provider(root) : await davProvider(root);
    const written = [];
    for (const [path, content] of Object.entries(files)) {
      const obj = await provider.upload(path, content, { mimeType: "text/plain" });
      written.push({ path: obj.path, providerId: obj.providerId, size: obj.size });
    }
    return { written };
  },

  async read({ backend, root, paths }) {
    const provider = backend === "s3" ? await s3Provider(root) : await davProvider(root);
    const contents = {};
    for (const path of paths) {
      const out = await provider.download(path);
      contents[path] = await out.text();
    }
    return { contents };
  },

  async list({ backend, root, path }) {
    const provider = backend === "s3" ? await s3Provider(root) : await davProvider(root);
    const objects = await provider.list(path);
    return {
      objects: objects
        .map((o) => ({ path: o.path, name: o.name, type: o.type ?? null, size: o.size ?? null }))
        .sort((a, b) => a.path.localeCompare(b.path))
    };
  },

  // --- encryption ---------------------------------------------------------

  async encrypt({ passphrase, plaintext, iterations }) {
    const { E2EECrypto } = await load("core");
    const crypto = new E2EECrypto(
      iterations ? { passphrase, keyDerivationIterations: iterations } : { passphrase }
    );
    const envelope = await crypto.encrypt(plaintext);
    return { envelopeHex: Buffer.from(envelope).toString("hex") };
  },

  async decrypt({ passphrase, envelopeHex }) {
    const { E2EECrypto } = await load("core");
    const crypto = new E2EECrypto({ passphrase });
    const plaintext = await crypto.decrypt(Uint8Array.from(Buffer.from(envelopeHex, "hex")));
    return { plaintext: new TextDecoder().decode(plaintext) };
  },

  // --- pure functions, for spot-checking the shared fixtures --------------

  async normalize({ paths }) {
    const { normalizeVirtualPath, encodePathSegments } = await load("core");
    return {
      results: paths.map((p) => ({
        input: p,
        normalized: normalizeVirtualPath(p),
        encoded: encodePathSegments(normalizeVirtualPath(p))
      }))
    };
  }
};

const handler = commands[command];
if (!handler) {
  console.error(JSON.stringify({ error: `Unknown command: ${command}` }));
  process.exit(2);
}

try {
  process.stdout.write(JSON.stringify(await handler(args)));
} catch (err) {
  console.error(JSON.stringify({ error: String(err?.message ?? err), code: err?.code ?? null }));
  process.exit(1);
}
