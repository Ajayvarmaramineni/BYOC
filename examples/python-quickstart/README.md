# Python quickstart

Mirrors [`../node-quickstart`](../node-quickstart), so the two SDKs can be
compared side by side.

```bash
pip install byoc-storage
python main.py
```

Runs offline by default. It registers all three providers, inspects their
capabilities, switches between them, and demonstrates client-side encryption
without contacting any server.

For a live round-trip, start a real S3 server first:

```bash
brew install minio
minio server /tmp/byoc-minio-data --address :9000
```

```bash
BYOC_DEMO_S3=1 python main.py
```
