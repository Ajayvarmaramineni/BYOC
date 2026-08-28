# Design: streaming I/O and chunked E2EE

**Status:** proposed, targeting v0.3.0
**Supersedes:** the buffered upload path and the `BYOC_E2EE_V2` envelope

---

## The problem

BYOC cannot handle a file larger than available memory.

```
Python adapters    reject streams outright: "Streaming uploads are not yet supported"
TypeScript S3      accepts Readable, but WebDAV and Drive still buffer
Python download    buffers response.content, then hands back a one-chunk iterator
E2EE               encrypt() takes the whole payload and returns the whole envelope
```

`StorageInput` in Python already *declares* `AsyncIterator[bytes]` and documents it
as streaming without buffering. That is currently untrue: the type is a promise the
adapters break. This design makes it true.

The consequence is not theoretical. A 150 MB lecture recording costs roughly 300 MB
of resident memory to encrypt, because the plaintext and the envelope both live in
memory at once. A 4 GB video is simply impossible.

Two independent problems hide behind one symptom:

1. **Transport buffering.** Adapters read the whole body before sending it.
2. **Cryptographic buffering.** AES-GCM produces one authentication tag over one
   message, so the whole plaintext must be processed before the tag is known.

The second is why `EncryptedStorageWrapper` reports `resumableUploads: false`.
Fixing transport alone would leave encryption unusable on large files.

---

## Part 1: the `BYOC_E2EE_V3` envelope

### Why the format has to change

AES-GCM authenticates one message with one tag. To decrypt a stream incrementally
you need many independently authenticated frames. That is a format change, not an
implementation change, so the magic header moves to `V3`.

Framing introduces three attacks that a single-message envelope does not have, and
the design has to close all three:

| Attack | Defence |
| :--- | :--- |
| Reorder frames | Frame index is bound as AAD |
| Drop trailing frames (truncation) | A final-frame flag is bound as AAD |
| Swap the header between files | The whole header is bound as AAD in every frame |

### Layout

```
Header, 44 bytes, cleartext but authenticated:

  offset  size  field
  ------  ----  ---------------------------------------------
       0    12  MAGIC        "BYOC_E2EE_V3"
      12     4  ITERATIONS   uint32 BE, PBKDF2 work factor
      16     4  FRAME_SIZE   uint32 BE, plaintext bytes per frame
      20    16  SALT         random, per file
      36     8  NONCE_BASE   random, per file
      ------------------------------------------------------
      44        end of header

Then one or more frames:

  offset  size  field
  ------  ----  ---------------------------------------------
       0     4  FRAME_LEN    uint32 BE, ciphertext byte count
       4    16  TAG          GCM authentication tag
      20     n  CIPHERTEXT   FRAME_LEN bytes
```

Per-frame overhead is 20 bytes. At the default 256 KiB frame that is 0.008%.

### Key and nonce derivation

```
key         = PBKDF2-HMAC-SHA256(passphrase, SALT, ITERATIONS, dkLen=32)
nonce[i]    = NONCE_BASE (8 bytes) || uint32_BE(i)     -> 12 bytes
aad[i]      = HEADER (44 bytes) || uint32_BE(i) || is_final (1 byte)
```

The key is derived once per file and reused across frames. That is safe because the
nonce is unique per frame; it is also what makes streaming affordable, since a
600,000-iteration PBKDF2 per frame would be unusable.

`NONCE_BASE` is defence in depth. The salt is random per file, so the key already
differs per file and a bare counter would be sufficient. The extra 8 random bytes
mean that an implementation which incorrectly caches a derived key across files
still does not reuse a nonce. Nonce reuse under GCM is catastrophic, so the 8 bytes
are cheap insurance against a plausible future bug.

### Truncation detection

The last frame sets `is_final = 1`; every other frame sets `0`. Because the flag is
bound as AAD, an attacker who deletes trailing frames leaves a stream whose last
delivered frame authenticates as non-final. The reader treats "input ended without a
final frame" as tampering, not as a clean end of file.

**An empty payload still emits exactly one frame**, containing zero plaintext bytes
and `is_final = 1`. Without it, a zero-frame envelope would have nothing
authenticating the header.

### Reading untrusted input

`FRAME_LEN` comes from storage the attacker may control and drives an allocation.
This is the same class of bug as the iteration count in V2, where a 4-byte edit could
force minutes of PBKDF2. Both fields are range-checked before they are used:

```
ITERATIONS   10_000 .. 2_000_000        (unchanged from V2)
FRAME_SIZE   4_096  .. 8_388_608        (4 KiB .. 8 MiB)
FRAME_LEN    0      .. FRAME_SIZE + 16  (a frame cannot exceed its declared size)
```

A violation raises `CORRUPTED_DATA` before any key derivation or allocation.

### Compatibility

`decrypt` dispatches on the magic header and keeps reading V1 and V2. `encrypt`
always writes V3. Nothing previously written becomes unreadable.

The buffered `encrypt_sync` / `decrypt_sync` entry points stay, implemented as thin
wrappers that feed a single-shot iterator through the streaming path. Small payloads
keep the simple API.

---

## Part 2: streaming transport

### The layers are independent

This matters and is easy to get wrong:

```
plaintext  ->  E2EE frames (256 KiB)  ->  provider chunks (8 MiB)  ->  HTTP
```

Frame boundaries and upload-chunk boundaries have nothing to do with each other.
Google Drive requires resumable chunks to be 256 KiB-aligned; ciphertext frames are
256 KiB *plus 20 bytes*, so they never align. That is fine. The uploader chunks the
ciphertext byte stream without knowing frames exist.

Keeping these layers separate is what lets encryption and resumable upload compose
at all, which is exactly what V2 could not do.

### Per-provider work

**WebDAV** is straightforward. A `PUT` with a chunked request body. `httpx` and
`undici` both accept an async iterator directly.

**Google Drive** already chunks for resumable uploads. The change is feeding
`upload_chunks` from an iterator rather than slicing a `bytes` object, and dropping
the `len(payload)` dependency by tracking offsets as chunks are consumed.

**S3 needs a decision, because SigV4 hashes the body.**

Signature Version 4 signs `sha256(body)`. You cannot compute that without reading
the entire body, which defeats streaming. There are two ways out:

| Option | Cost |
| :--- | :--- |
| `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` | Per-chunk signatures, a second framing layer inside the request body, meaningful complexity |
| `UNSIGNED-PAYLOAD` | One header change; the body is not covered by the signature |

**Recommendation: `UNSIGNED-PAYLOAD`, for streaming uploads only.** The request is
still authenticated, and over TLS the body is still confidential and integrity-protected
by the transport. This is what most S3 SDKs do for streams. Buffered uploads keep
signing the real body hash, so nothing regresses for existing callers.

This is a security-relevant tradeoff and belongs in `SECURITY.md`, not buried in an
adapter. Callers who need body-level signing can pass `bytes` and get the current
behaviour.

### Downloads

`StorageOutput.stream()` becomes genuinely lazy. Today Python reads
`response.content` up front and hands back an iterator over one chunk, so the
"streaming" accessor buffers. The response context has to stay open until the caller
finishes consuming, which means `download()` returns an object that owns the
response rather than one built after the fact.

`read()` and `text()` keep working by draining the stream.

### Migration

Python's migration currently does `await output.read()`. With streaming downloads it
pipes source to target directly, matching what TypeScript already does. That removes
the last place a whole file is held in memory.

---

## Part 3: conformance

The current fixtures pin byte formats. They cannot catch the divergence that already
exists, where TypeScript streams and Python does not, because both produce the same
stored bytes. Streaming needs behavioural coverage.

**`spec/fixtures/e2ee-envelope.json` gains V3 vectors.** With `SALT` and `NONCE_BASE`
fixed, the envelope is byte-reproducible, so both SDKs can assert an exact hex match
as they do for V2 today. Add vectors for: an empty payload, a payload smaller than
one frame, and a payload spanning three frames.

**New rejection cases**, each of which must raise before any allocation:

- final frame removed (truncation)
- frames 1 and 2 swapped (reordering)
- `FRAME_LEN` set to `0xFFFFFFFF` (oversized allocation)
- `FRAME_SIZE` set to 16 (below the floor)
- one header byte flipped (header tampering, caught by AAD)

**New `spec/fixtures/streaming.json`.** The invariant is that transport shape must not
change stored bytes:

```
upload(path, bytes)                     ->  object A
upload(path, iterator over same bytes)  ->  object B
assert A == B, byte for byte
```

Run in both SDKs, against MinIO and WebDAV, with chunk sizes chosen to fall on and
off frame boundaries. This is the test that would have caught the current divergence.

---

## Sequencing

Each step lands green and independently useful.

| Step | Work | Why this order |
| :--- | :--- | :--- |
| 1 | V3 envelope in Python, buffered API on top | Format first, no transport changes to confuse failures |
| 2 | V3 in TypeScript, cross-SDK vectors | Locks the format before anything depends on it |
| 3 | Streaming download, both SDKs | Simpler than upload, no signing questions |
| 4 | Streaming upload: WebDAV, then Drive, then S3 | Increasing difficulty; S3 last because of the SigV4 decision |
| 5 | `streaming.json` and interop coverage | Proves the SDKs did not drift |
| 6 | Wire E2EE into the streaming path | Only now can `resumableUploads` stop being forced to `false` |
| 7 | Python migration streams | Removes the last full-file buffer |

Steps 1 and 2 are the risky ones. Step 6 is the payoff: `EncryptedStorageWrapper`
stops overriding `resumableUploads` to `false`, and encryption composes with
multi-gigabyte uploads.

## Open questions

**Default frame size.** 256 KiB matches Drive's alignment and keeps overhead at
0.008%. Larger frames mean less overhead and more memory held per frame. The default
should be set from measurements against representative media files, not chosen from
the alignment constant alone.

**Does `FRAME_SIZE` belong in the header at all?** It could be implied by the first
frame's length. Storing it explicitly costs 4 bytes and lets a reader validate every
frame against a declared bound, which is worth more than the bytes.

**Progress reporting for streams.** `UploadProgress.total_bytes` is currently derived
from `len(payload)`. A stream of unknown length cannot provide it. The field becomes
`None`, and `percentage` with it. Callers relying on a percentage need to know that.
