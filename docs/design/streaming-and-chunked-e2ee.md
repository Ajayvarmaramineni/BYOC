# Design: streaming I/O and chunked E2EE

**Status:** V3 cryptographic framing implemented; provider transport work in progress for v0.4
**Supersedes:** the buffered upload path and the `BYOC_E2EE_V2` envelope

V3 is now the write format in both SDKs. TypeScript's encrypted wrapper streams
through stream-capable providers, and streamed S3 requests use
`UNSIGNED-PAYLOAD`. Python's cryptographic stream API is implemented, while its
network adapters and migration path still need to consume streams without
buffering. V1 and V2 remain read-compatible.

---

## The problem

In v0.3, BYOC could not handle a file larger than available memory through every
provider and encryption combination.

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

V3 fixes the cryptographic half. The remaining work is making every adapter honor
the stream contract and adding durable provider-native upload checkpoints.

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
FRAME_LEN    0      .. FRAME_SIZE       (the tag is stored separately)
```

An invalid iteration count raises `CORRUPTED_DATA` before key derivation. Invalid
frame fields are rejected before their values drive a frame read or allocation.

### Compatibility

`decrypt` dispatches on the magic header and keeps reading V1 and V2. `encrypt`
always writes V3. Nothing previously written becomes unreadable.

The buffered `encrypt` / `decrypt` and Python `encrypt_sync` / `decrypt_sync`
entry points stay and use the same V3 layout. Small payloads keep the simple API.

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

**Implemented: `UNSIGNED-PAYLOAD`, for streaming uploads only.** The request is
still authenticated, and over TLS the body is still confidential and integrity-protected
by the transport. This is what most S3 SDKs do for streams. Buffered uploads keep
signing the real body hash, so nothing regresses for existing callers.

S3-compatible servers are not uniform about transfer-encoded request bodies.
MinIO requires `Content-Length` for this PUT form, so portable stream uploads require
`UploadOptions.contentLength`. The encrypted wrapper computes the exact V3 envelope
length from that plaintext length. Unknown-length S3 streams fail before network I/O
until multipart checkpoints provide a portable alternative.

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

**`spec/fixtures/e2ee-envelope.json` contains a deterministic V3 vector.** With
`SALT` and `NONCE_BASE` fixed, both SDKs assert an exact envelope match. Generated
security tests cover empty payloads and payloads spanning multiple frames.

**New rejection cases**, with hostile lengths rejected before they drive allocation:

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

| Step | Status | Work |
| :--- | :--- | :--- |
| 1 | Done | V3 envelope in Python with buffered and streaming APIs |
| 2 | Done | V3 in TypeScript with a shared deterministic cross-SDK vector |
| 3 | Partial | Core decryption streams; Python network downloads still buffer |
| 4 | Partial | TypeScript WebDAV/S3 streams; S3 was exercised against live MinIO, while Drive and Python network adapters need work |
| 5 | Partial | Adversarial chunk-boundary, runtime interop, and an 8 MiB live encrypted MinIO transfer pass; the large live transport fixture remains |
| 6 | TypeScript done | Encrypted wrapper streams and preserves resumable capability |
| 7 | Pending | Python migration streams |

The wire-format risk is now pinned by both SDKs. The next payoff is end-to-end
bounded memory in every network adapter, measured with a multi-gigabyte fixture.

## Open questions

**Default frame size.** 256 KiB matches Drive's alignment and keeps overhead at
0.008%. Larger frames mean less overhead and more memory held per frame. The default
should be set from measurements against representative media files, not chosen from
the alignment constant alone.

**Does `FRAME_SIZE` belong in the header at all?** It could be implied by the first
frame's length. Storing it explicitly costs 4 bytes and lets a reader validate every
frame against a declared bound, which is worth more than the bytes.

**Progress reporting for streams.** A stream of unknown length cannot provide a
percentage. TypeScript callers can now supply `UploadOptions.contentLength`; Python
has the matching contract but its adapters do not consume streams yet.
