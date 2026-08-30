import { BYOC } from "@byoc/core";
import {
  GoogleDriveProvider,
  GoogleDriveScope,
  generateCodeVerifier,
  generateCodeChallenge,
  generateOAuthState
} from "@byoc/google-drive";
import { S3CompatibleProvider } from "@byoc/s3-compatible";
import { WebDAVProvider } from "@byoc/webdav";
import { LocalFileSystemProvider } from "@byoc/local";
import { MemoryProvider } from "@byoc/memory";

async function main() {
  console.log("=== BYOC (Bring Your Own Cloud) Ecosystem Demo ===\n");

  // 0. A real round trip, with no account and no network.
  //    Everything below this block uses placeholder credentials and only
  //    demonstrates shapes; this part genuinely reads and writes.
  console.log("0. Real storage round trip, no credentials required:");
  const scratch = new BYOC({ provider: new MemoryProvider() });
  await scratch.connect();

  await scratch.writeText("reports/q3.md", "# Q3 results");
  await scratch.copy("reports/q3.md", "reports/q3-backup.md");
  console.log("   read back:  ", await scratch.readText("reports/q3-backup.md"));

  const walked: string[] = [];
  for await (const item of scratch.walk("reports")) walked.push(item.path);
  console.log("   walk:       ", walked.join(", "));

  const removed = await scratch.deleteTree("reports");
  console.log(`   deleteTree:  removed ${removed.deleted.length}, failed ${removed.failed.length}`);
  console.log("   Swap MemoryProvider for LocalFileSystemProvider and it writes real files.\n");

  // 1. Generate PKCE Security Parameters
  const codeVerifier = generateCodeVerifier(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const oauthState = generateOAuthState(32);

  console.log("1. PKCE Security Handshake:");
  console.log("   - Code Challenge:", codeChallenge);
  console.log("   - State:", oauthState);

  // 2. Initialize 3 Multi-Cloud Adapters
  // Personal Cloud: Google Drive
  const googleDrive = new GoogleDriveProvider({
    auth: {
      clientId: "demo-client-id.apps.googleusercontent.com",
      redirectUri: "http://localhost:3000/callback",
      scopes: [GoogleDriveScope.FILE],
      session: {
        accessToken: "mock-demo-access-token",
        expiresAt: Date.now() + 3600 * 1000
      }
    },
    rootFolderName: "MyDemoApp"
  });

  // Developer Cloud: Cloudflare R2 / AWS S3
  const cloudflareR2 = new S3CompatibleProvider({
    endpoint: "https://my-account-id.r2.cloudflarestorage.com",
    bucket: "user-backups",
    region: "auto",
    accessKeyId: "mock-r2-key",
    secretAccessKey: "mock-r2-secret",
    rootPrefix: "app-data"
  });

  // Self-Hosted / Privacy: Nextcloud / WebDAV
  const nextcloud = new WebDAVProvider({
    endpoint: "https://nextcloud.mycompany.com/remote.php/dav/files/user/",
    username: "john_doe",
    password: "app-password-123",
    rootFolder: "MyApp"
  });

  // Local disk: no account, no network, no credentials.
  const localDisk = new LocalFileSystemProvider({ rootDirectory: "./byoc-demo-storage" });

  // 3. Initialize Universal BYOC Client with every ownership model
  const storage = new BYOC({
    providers: [googleDrive, cloudflareR2, nextcloud, localDisk],
    defaultProviderId: "google-drive"
  });

  console.log("\n2. Registered Storage Providers in BYOC Runtime:");
  for (const manifest of storage.getProviders()) {
    console.log(`   - [${manifest.category.toUpperCase()}] ${manifest.name} (id: ${manifest.id}, auth: ${manifest.authentication})`);
  }

  // 4. Inspect Capabilities
  console.log("\n3. Active Provider Capabilities (" + storage.manifest().name + "):");
  console.log("   - Folders:", await storage.hasCapability("folders"));
  console.log("   - Quota:", await storage.hasCapability("quota"));
  console.log("   - Resumable Uploads:", await storage.hasCapability("resumableUploads"));

  // 5. Dynamic Switching Demonstration
  console.log("\n4. Dynamic Provider Switching:");
  storage.useProvider("s3-compatible");
  console.log("   Switched active provider to:", storage.manifest().name, `(${storage.manifest().category})`);

  storage.useProvider("webdav");
  console.log("   Switched active provider to:", storage.manifest().name, `(${storage.manifest().category})`);

  storage.useProvider("local");
  console.log("   Switched active provider to:", storage.manifest().name, `(${storage.manifest().category})`);

  console.log("\n5. Ready to migrate data between user clouds and developer clouds with zero code changes!");
}

main().catch((err) => {
  console.error("BYOC Error:", err);
});
