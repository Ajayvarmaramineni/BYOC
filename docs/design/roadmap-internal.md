> **Internal roadmap, not positioning.**
>
> This is where BYOC is going over several releases. It is deliberately not the
> public pitch: "portable data control plane" is a destination, and a reader
> who has never used BYOC feels nothing when they read it. The launch story
> lives in [`v0.4-pitch.md`](./v0.4-pitch.md) and is deliberately smaller and
> more concrete -- the bytes never touch your server -- because that is the
> part that is built, demonstrable, and immediately felt.
>
> Wedge first, destination second. Keep the two apart.

# BYOC v0.4: from storage adapter to portable data control plane

**Status:** architecture direction with the first data-plane milestone implemented

## Product thesis

BYOC should not try to win by becoming another list of cloud adapters. Apache
OpenDAL already exposes a broad operator model across many services, and rclone is
excellent at command-line transfer and synchronization. BYOC can own a different
problem:

> Let an application store, verify, move, observe and recover user data across
> storage the user controls, while making provider differences explicit.

That is a portable data control plane. The user's bucket, Drive, WebDAV server or
mounted volume remains the source of truth. BYOC supplies the guarantees that
application teams otherwise rebuild badly: encryption, integrity, migration
checkpoints, change cursors, policy and evidence.

This direction also matches the broader move toward portability. The EU Data Act
requires cloud-switching support, open interfaces in relevant services and
structured machine-readable export in specified cases. BYOC is not a compliance
certificate, but application-level portability is becoming infrastructure rather
than a nice-to-have. See the [final Regulation (EU) 2023/2854](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R2854).

## What the research changed

### Do not flatten provider truth

Mature abstractions keep operations stable while layering retry, logging, timeouts
and metrics around them. [Apache OpenDAL's model](https://opendal.apache.org/docs/concepts/)
is strong evidence for that split. BYOC should evolve its seven capability booleans
into structured guarantees:

~~~ts
interface ProviderProfile {
  transfer: {
    upload: "buffered" | "streaming" | "resumable";
    download: "buffered" | "streaming" | "range";
    maxObjectBytes?: number;
  };
  consistency: {
    readAfterWrite: "strong" | "eventual" | "unknown";
    conditionalCreate: boolean;
    conditionalReplace: boolean;
  };
  integrity: {
    algorithms: Array<"sha256" | "crc32c" | "crc64nvme" | "md5">;
    serverValidated: boolean;
    multipartScope: "full" | "composite" | "none";
  };
  changes: {
    mode: "native-cursor" | "polling" | "none";
  };
}
~~~

This matters because an S3 ETag is not a universal checksum. AWS documents that
multipart ETags are not necessarily whole-object MD5 values and separately exposes
full and composite checksums. BYOC should represent algorithm, value, encoding,
scope and whether the provider validated it. See [S3 object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).

### Treat transfer as a durable protocol

A boolean named resumable cannot represent a real recovery contract. The
[tus protocol](https://tus.io/protocols/resumable-upload) and the
[IETF HTTP resumable-upload draft](https://datatracker.ietf.org/doc/draft-ietf-httpbis-resumable-upload/)
both center an upload resource, an offset and explicit completion/cancellation.
BYOC needs a portable checkpoint containing provider id, destination, bytes
committed, object fingerprint and opaque adapter state.

### Make changes cursor-based

Google Drive has start page tokens and a changes feed; WebDAV defines sync tokens;
Microsoft Graph returns delta links. All are opaque cursors, but their deletion and
path semantics differ. The portable API should preserve provider state rather than
inventing timestamps:

~~~ts
const page = await storage.changes({ cursor, scope: "projects/acme" });
persist(page.cursor);
for (const change of page.changes) applyLatestState(change);
~~~

Primary references:
[Google Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes),
[WebDAV collection sync](https://www.rfc-editor.org/rfc/rfc6578), and
[Microsoft Graph delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta).

### Encrypt the stream, not the file-sized buffer

Both [Google Tink Streaming AEAD](https://developers.google.com/tink/encrypt-large-files-or-data-streams)
and [libsodium secretstream](https://doc.libsodium.org/secret-key_cryptography/secretstream)
bind authenticated segments to their position and detect reordering, modification
and truncation. BYOC V3 follows those properties while retaining AES-GCM and the
existing dependency set:

- one PBKDF2-HMAC-SHA256 key derivation per object;
- 256 KiB default plaintext frames;
- unique nonce per frame from an 8-byte random base plus a 32-bit index;
- full header, index and final-frame marker bound as AAD;
- exact V1/V2 read compatibility;
- range checks before attacker-controlled iteration counts or frame lengths are used.

PBKDF2 with a per-object salt remains aligned with
[NIST SP 800-132](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-132.pdf).
A future Argon2id envelope can be added as a new version after cross-runtime support
and migration ergonomics are proven; silently changing V3 would be unacceptable.

## Implemented in this upgrade

1. BYOC_E2EE_V3 framed envelopes in TypeScript and Python.
2. encryptStream/decryptStream and encrypt_stream/decrypt_stream with memory bounded
   by the configured frame size.
3. Empty-object final frames and authenticated protection against frame removal,
   reordering, oversized lengths, header tampering and wrong keys.
4. A shared deterministic V3 fixture consumed by both SDKs.
5. Cross-SDK runtime tests in both directions without requiring a live S3 server.
6. TypeScript EncryptedStorageWrapper now sends encrypted streams and preserves
   the underlying provider's resumable capability.
7. S3 streamed PUTs use AWS's documented SigV4
   [UNSIGNED-PAYLOAD](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)
   sentinel instead of signing the SHA-256 of an empty body.
8. One-shot S3 and WebDAV streams are not blindly retried after consumption.
9. Exact `contentLength` propagation makes encrypted streaming PUTs portable to
   MinIO; an 8 MiB live round trip passed with ciphertext verified and decrypted.

The security tradeoff for S3 is explicit: streamed request bodies rely on TLS plus
per-frame E2EE integrity and use UNSIGNED-PAYLOAD; buffered inputs remain buffered
through the encrypted wrapper and continue to sign the actual body hash. A strict
bucket policy may reject unsigned payloads. Provider-native multipart checkpoints
are the later solution for retryable large S3 uploads.

## The moat: four releases, in order

### v0.4.1: truthful large-object transport

- Stream Python S3, WebDAV, Drive and migration paths without response.content.
- Stream Google Drive resumable chunks without first converting to one array.
- Add cancellation, deadlines and byte-range reads.
- Replace one-shot retries with provider-native resumable checkpoints.
- Add 1 GiB bounded-memory integration tests for Local, MinIO and WebDAV.

Current core baseline on the development machine: a 1 GiB encrypt/decrypt pipeline
with 64 KiB frames verified its SHA-256 with a 157 MiB peak RSS increase. Run
`npm run benchmark:streaming -- 1024 64` to repeat it. The v0.4.1 exit criterion
is a peak RSS increase below 192 MiB for the same workload through Local, MinIO,
and WebDAV, with memory staying flat as object size increases.

### v0.5: Storage Passport

Create a deterministic, provider-neutral manifest:

~~~json
{
  "format": "byoc-passport/v1",
  "root": "projects/acme",
  "objects": [
    {
      "path": "src/main.ts",
      "size": 1204,
      "checksum": { "algorithm": "sha256", "value": "...", "scope": "full" }
    }
  ],
  "manifestSha256": "..."
}
~~~

The API produces snapshots, diffs two snapshots and verifies stored bytes. It
turns migration from "the copy request returned 200" into evidence that a dataset
arrived intact. Provider checksums are used only when their algorithm and scope
match; otherwise BYOC computes SHA-256 while streaming.

### v0.6: durable migration and sync

- Persistent migration journals with per-object state and restart recovery.
- Conditional destination writes to stop silent overwrite races; [AWS documents
  these preconditions directly](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html).
- Native changes adapters for Drive and WebDAV, then Graph/OneDrive and Dropbox.
- Explicit conflict records instead of last-writer-wins guesses.
- Dry-run plans that estimate bytes, requests, unsupported metadata and likely cost.

### v0.7: policy and replication

~~~ts
const storage = byoc.policy({
  route: [
    { when: { classification: "regulated" }, to: ["eu-primary", "eu-backup"] },
    { when: { sizeAbove: "1GiB" }, to: ["r2-archive"] }
  ],
  replication: { acknowledgements: 2, repair: "background" },
  retention: { versions: 30 }
});
~~~

Policies must return evidence: which copies committed, which checksum was verified,
and what repair remains. BYOC should never call a two-provider copy atomic.

### v1.0: operational control plane

- Composable middleware for retry, rate limiting, tracing, metrics and audit.
- Neutral operation events with an optional OpenTelemetry bridge, following the
  [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/).
- A byoc doctor command that actively tests auth, write/read/list/delete, checksum
  behavior, clock skew, range support and cleanup.
- Stable capability/profile schema, compatibility policy and provider certification.
- Threat model, external cryptography review, fuzzing corpus and restore drills.

## What not to build

- **A hosted proxy for every byte.** It recreates the storage bill and trust problem.
- **A fake POSIX filesystem.** Rename, locking and consistency differ too much.
- **A universal sync that hides conflicts.** Durable journals and explicit policy
  must come first.
- **Content deduplication before the privacy model is settled.** Cross-user
  deduplication leaks equality and complicates ownership.
- **Dozens of adapters before certification.** Five trustworthy providers beat
  fifty unverified logos.

## Production gates

The project should not call itself production-ready until all of these are true:

- external review of V3 framing and key-management guidance;
- property/fuzz tests for parsers and truncated/corrupted streams;
- Python transport streaming and durable resumable sessions;
- conditional writes and normalized checksums;
- provider live tests pinned to known server versions, plus scheduled compatibility runs;
- telemetry with path/credential redaction and cardinality limits;
- signed releases, provenance/SBOM, automated dependency review and a disclosure SLA;
- load, cancellation, crash-recovery and restore tests with published numbers;
- explicit support matrix for Node/Python/runtime/provider combinations.

## GitHub launch plan

No engineering change can guarantee a number-one GitHub ranking in a week. A release
can, however, be unusually easy to understand and trust:

1. Publish a two-minute demo: encrypt and migrate a multi-gigabyte project between a
   local folder, MinIO/R2 and Drive while memory stays flat.
2. Put a measured benchmark and a failure/restart demo above the provider list.
3. Lead with one sentence: **"Your app, your users' clouds, one verifiable data plane."**
4. Ship a copy-paste quickstart for TypeScript and Python and a runnable local demo
   requiring no cloud account.
5. Open roadmap issues for Storage Passport, durable checkpoints and change cursors
   with acceptance criteria so contributors can join real work.
6. Publish the wire format and threat model; invite cryptography and storage review.

The durable win is not a one-week ranking. It is becoming the storage layer a team
can adopt without surrendering data ownership or operational evidence.
