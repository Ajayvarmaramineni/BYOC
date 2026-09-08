# Direct upload demo

A page that uploads a file to storage, and a server that never sees it.

The server does two things: serve the page, and sign a short-lived permission
to write one object. Every request it receives is logged with a byte count, so
the log is the proof — a small `GET` for the grant, then nothing at all while
hundreds of megabytes move.

```
01:11:38  GET  /api/grant     no body   total through server: 0 B
01:11:38  GET  /api/verify    no body   total through server: 0 B
```

## Run it

No cloud account needed. MinIO is a real S3 server and runs locally:

```bash
brew install minio
minio server /tmp/byoc-demo --address :9000
```

Create a `byoc-demo` bucket in it, then:

```bash
npm install
npm start
```

Open <http://localhost:4000>, drop in a large file, and watch the terminal.

To point at a real bucket instead:

```bash
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
S3_BUCKET=my-bucket \
S3_ACCESS_KEY=... S3_SECRET_KEY=... \
npm start
```

Your bucket needs a CORS rule allowing `PUT` from `http://localhost:4000`, or
the browser blocks the request before it is sent.

## What to look at

**`server.mjs`** is about 90 lines and the interesting part is how little it
does. `createUploadGrant()` returns plain JSON with no credential of yours in
it; that JSON goes to the browser and the browser talks to storage.

**`public/index.html`** loads `@byoc/browser` straight from a CDN, so there is
no build step. It is the same published package an application installs from
npm.

The `/api/verify` route exists so the demo proves the file *arrived*. A progress
bar reaching 100% proves nothing on its own — it asks the provider what actually
landed and reports the size.

## Recording it

For a GIF, put the browser and the server's terminal side by side. The
right-hand pane staying empty is the whole point, so give it as much room as
the browser. End the shot on the confirmed size rather than on the progress bar,
or a viewer can reasonably assume the bytes went nowhere.

```bash
ffmpeg -i demo.mov \
  -vf "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 demo.gif
```

Keep it under 5 MB, or GitHub serves it slowly enough that people scroll past.

## Caveats

A grant is a **bearer capability**: whoever holds it can write to that one path
until it expires. This demo hands one to anybody who asks, which is fine for a
demo and wrong for an application. In production, issue a grant only after
checking the caller is allowed to write there.
