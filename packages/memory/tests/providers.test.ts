/**
 * Behavioural suite for the two credential-free providers.
 *
 * Both are driven through the same assertions, because the point of shipping
 * them is that code written against one BYOC provider behaves the same against
 * any other. A divergence here is a bug in whichever one differs.
 *
 * It lives in the memory package because that one has no Node-only imports and
 * so can host the shared cases for both.
 */
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BYOC, BYOCErrorCode, type BYOCProvider, type StorageError } from "@byoc/core";
import { LocalFileSystemProvider } from "../../local/src/adapter.js";
import { MemoryProvider } from "../src/adapter.js";

/**
 * Filenames that have historically broken adapters: `#` and `?` truncated an
 * object key, `+` was mis-decoded as a space, and non-ASCII broke signing.
 */
const AWKWARD_NAMES = ["draft#2.pdf", "q?x.txt", "sp ace.txt", "ümlaut.txt", "a+b.txt", "100%.txt"];

interface Subject {
  readonly label: string;
  readonly hasFolders: boolean;
  create(): Promise<BYOCProvider>;
}

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "byoc-suite-"));
  tempRoots.push(root);
  return root;
}

const SUBJECTS: Subject[] = [
  {
    label: "MemoryProvider",
    hasFolders: false,
    create: async () => new MemoryProvider({ quotaBytes: 1024 * 1024 })
  },
  {
    label: "LocalFileSystemProvider",
    hasFolders: true,
    create: async () =>
      new LocalFileSystemProvider({ rootDirectory: path.join(await makeTempRoot(), "root") })
  }
];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function errorCodeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as StorageError).code;
  }
}

for (const subject of SUBJECTS) {
  describe(subject.label, () => {
    let storage: BYOC;

    beforeEach(async () => {
      storage = new BYOC({ provider: await subject.create() });
      await storage.connect();
    });

    afterEach(async () => {
      await storage.disconnect();
    });

    // -- round trips ------------------------------------------------------

    it("round-trips text through write and read", async () => {
      const written = await storage.writeText("docs/report.md", "# Hello");

      expect(written.path).toBe("docs/report.md");
      expect(written.size).toBe(7);
      expect(await storage.readText("docs/report.md")).toBe("# Hello");
    });

    it("distinguishes present from missing objects", async () => {
      await storage.writeText("a.txt", "x");

      expect(await storage.exists("a.txt")).toBe(true);
      expect(await storage.exists("missing.txt")).toBe(false);
      // The root is a container, never a file.
      expect(await storage.exists("")).toBe(false);
    });

    it("reports accurate size in metadata", async () => {
      await storage.writeText("notes/readme.md", "hello world");
      const found = await storage.metadata("notes/readme.md");

      expect(found.size).toBe(11);
      expect(found.name).toBe("readme.md");
      expect(found.path).toBe("notes/readme.md");
    });

    it("raises OBJECT_NOT_FOUND for a missing object", async () => {
      expect(await errorCodeOf(() => storage.metadata("nope.txt"))).toBe(
        BYOCErrorCode.OBJECT_NOT_FOUND
      );
      expect(await errorCodeOf(() => storage.download("nope.txt"))).toBe(
        BYOCErrorCode.OBJECT_NOT_FOUND
      );
    });

    it("preserves custom metadata across a round trip", async () => {
      await storage.upload("tagged.bin", Buffer.from("payload"), {
        mimeType: "application/x-custom",
        metadata: { owner: "alex" }
      });
      const found = await storage.metadata("tagged.bin");

      expect(found.mimeType).toBe("application/x-custom");
      expect(found.metadata?.owner).toBe("alex");
    });

    // -- listing ----------------------------------------------------------

    it("lists one level only", async () => {
      await storage.writeText("top.txt", "a");
      await storage.writeText("docs/one.txt", "b");
      await storage.writeText("docs/deep/two.txt", "c");

      const names = (await storage.list("docs")).map((item) => item.name);

      expect(names).toContain("one.txt");
      // `deep/two.txt` must not appear as a flattened child.
      expect(names).not.toContain("two.txt");
    });

    it("returns paths that can be fed straight back in", async () => {
      await storage.writeText("docs/one.txt", "content");

      const files = (await storage.list("docs")).filter((item) => item.type !== "folder");
      expect(files.length).toBeGreaterThan(0);

      for (const item of files) {
        expect(await storage.readText(item.path)).toBe("content");
      }
    });

    // -- awkward filenames ------------------------------------------------

    it.each(AWKWARD_NAMES)("round-trips the filename %s", async (name) => {
      await storage.writeText(`odd/${name}`, `payload::${name}`);

      expect(await storage.readText(`odd/${name}`)).toBe(`payload::${name}`);
      expect((await storage.list("odd")).map((item) => item.name)).toContain(name);
    });

    it("keeps similarly named files apart", async () => {
      // The 0.1.0 bug: `draft#2.pdf` and `draft#3.pdf` both wrote to `draft`.
      await storage.writeText("draft#2.pdf", "two");
      await storage.writeText("draft#3.pdf", "three");

      expect(await storage.readText("draft#2.pdf")).toBe("two");
      expect(await storage.readText("draft#3.pdf")).toBe("three");
    });

    // -- copy, move, delete -----------------------------------------------

    it("leaves the source in place on copy", async () => {
      await storage.writeText("src.txt", "content");
      await storage.copy("src.txt", "nested/dst.txt");

      expect(await storage.readText("nested/dst.txt")).toBe("content");
      expect(await storage.exists("src.txt")).toBe(true);
    });

    it("removes the source on move", async () => {
      await storage.writeText("src.txt", "content");
      await storage.move("src.txt", "nested/dst.txt");

      expect(await storage.readText("nested/dst.txt")).toBe("content");
      expect(await storage.exists("src.txt")).toBe(false);
    });

    it("treats delete as idempotent", async () => {
      await storage.writeText("gone.txt", "x");
      await storage.delete("gone.txt");
      // A second delete is a no-op, not an error, on every adapter.
      await storage.delete("gone.txt");

      expect(await storage.exists("gone.txt")).toBe(false);
    });

    // -- streaming --------------------------------------------------------

    it("streams a download in several chunks", async () => {
      const payload = Buffer.alloc(200_000, "x");
      await storage.upload("big.bin", payload);

      const output = await storage.download("big.bin");
      const chunks: Buffer[] = [];
      for await (const chunk of output.stream as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("accepts an async iterator as upload input", async () => {
      async function* chunks(): AsyncGenerator<Buffer> {
        yield Buffer.from("str");
        yield Buffer.from("eam");
        yield Buffer.from("ed!");
      }

      await storage.upload("streamed.bin", chunks() as never);

      expect(await storage.readText("streamed.bin")).toBe("streamed!");
    });

    // -- recursive and batch operations -----------------------------------

    it("walks objects at every depth", async () => {
      // Regression: on a flat provider `walk` returned only the top level.
      // MemoryProvider did not emit synthetic folder entries for deeper keys,
      // so there was nothing to descend into and everything nested was invisible.
      for (const p of ["docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"]) {
        await storage.writeText(p, p);
      }

      const found: string[] = [];
      for await (const item of storage.walk("docs")) found.push(item.path);

      expect(found).toEqual(
        expect.arrayContaining(["docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"])
      );
    });

    it("keeps the walk inside the requested subtree", async () => {
      await storage.writeText("docs/inside.txt", "a");
      await storage.writeText("other/outside.txt", "b");

      const found: string[] = [];
      for await (const item of storage.walk("docs")) found.push(item.path);

      expect(found).toContain("docs/inside.txt");
      expect(found).not.toContain("other/outside.txt");
    });

    it("removes every descendant on deleteTree", async () => {
      // Regression: this reported success while leaving nested objects behind.
      const nested = ["docs/one.txt", "docs/deep/two.txt", "docs/deep/deeper/three.txt"];
      for (const p of nested) await storage.writeText(p, p);
      await storage.writeText("keep.txt", "untouched");

      const report = await storage.deleteTree("docs");

      expect(report.allSucceeded, JSON.stringify(report.failed)).toBe(true);
      for (const p of nested) {
        expect(await storage.exists(p), `${p} survived deleteTree`).toBe(false);
      }
      expect(await storage.readText("keep.txt")).toBe("untouched");
    });

    it("refuses to delete the tree at an empty path", async () => {
      // An empty path is the storage root; wiping it must be deliberate.
      expect(await errorCodeOf(() => storage.deleteTree(""))).toBe(BYOCErrorCode.INVALID_INPUT);
    });

    it("reports each path from deleteMany", async () => {
      await storage.writeText("a.txt", "a");
      await storage.writeText("b.txt", "b");

      const report = await storage.deleteMany(["a.txt", "b.txt", "never-existed.txt"]);

      // Deletion is idempotent everywhere, so a missing path is a success.
      expect([...report.deleted].sort()).toEqual(["a.txt", "b.txt", "never-existed.txt"]);
      expect(report.failed).toEqual([]);
      expect(report.total).toBe(3);
      expect(report.allSucceeded).toBe(true);
    });

    it("rejects a zero concurrency on deleteMany", async () => {
      expect(await errorCodeOf(() => storage.deleteMany(["a.txt"], 0))).toBe(
        BYOCErrorCode.INVALID_INPUT
      );
    });

    it("refuses a signed URL without the capability", async () => {
      // Neither provider can hand a browser a working URL, so both must say so.
      expect((await storage.capabilities()).publicUrls).toBe(false);

      await storage.writeText("a.txt", "x");
      expect(await errorCodeOf(() => storage.getSignedUrl("a.txt"))).toBe(
        BYOCErrorCode.CAPABILITY_UNSUPPORTED
      );
    });

    // -- capabilities -----------------------------------------------------

    it("backs every declared capability with a working method", async () => {
      const caps = await storage.capabilities();
      expect(caps.folders).toBe(subject.hasFolders);

      if (caps.folders) {
        const created = await storage.createFolder("newdir/nested");
        expect(created.type).toBe("folder");
        expect(await storage.exists("newdir/nested")).toBe(true);
      } else {
        expect(await errorCodeOf(() => storage.createFolder("newdir"))).toBe(
          BYOCErrorCode.CAPABILITY_UNSUPPORTED
        );
      }

      if (caps.serverSideCopy) {
        await storage.writeText("cap.txt", "x");
        await storage.copy("cap.txt", "cap-copy.txt");
        expect(await storage.exists("cap-copy.txt")).toBe(true);
      }

      if (caps.quota) {
        expect((await storage.getQuota()).used).toBeGreaterThanOrEqual(0);
      }
    });

    // -- safety -----------------------------------------------------------

    it.each([
      "../escape.txt",
      "docs/../../escape.txt",
      "../../../../../../etc/byoc-escape",
      "docs/../../../escape.txt"
    ])("refuses the traversal attempt %s", async (attack) => {
      const code = await errorCodeOf(() => storage.writeText(attack, "PWNED"));

      expect([BYOCErrorCode.INVALID_INPUT, BYOCErrorCode.PERMISSION_DENIED]).toContain(code);
    });
  });
}

describe("LocalFileSystemProvider specifics", () => {
  it("refuses to follow a symlink out of the root", async () => {
    // Traversal filtering alone does not catch this: the path has no `..`.
    const base = await makeTempRoot();
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fsp.mkdir(root);
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "secret.txt"), "classified");
    await fsp.symlink(outside, path.join(root, "backdoor"));

    const storage = new BYOC({ provider: new LocalFileSystemProvider({ rootDirectory: root }) });
    await storage.connect();
    try {
      expect(await errorCodeOf(() => storage.readText("backdoor/secret.txt"))).toBe(
        BYOCErrorCode.PERMISSION_DENIED
      );
      expect(await errorCodeOf(() => storage.writeText("backdoor/planted.txt", "PWNED"))).toBe(
        BYOCErrorCode.PERMISSION_DENIED
      );
    } finally {
      await storage.disconnect();
    }

    await expect(fsp.access(path.join(outside, "planted.txt"))).rejects.toThrow();
  });

  it("never writes outside its root", async () => {
    const base = await makeTempRoot();
    const root = path.join(base, "root");

    const storage = new BYOC({ provider: new LocalFileSystemProvider({ rootDirectory: root }) });
    await storage.connect();
    try {
      await storage.writeText("a/b/c.txt", "inside");
    } finally {
      await storage.disconnect();
    }

    const entries = await fsp.readdir(base);
    expect(entries).toEqual(["root"]);
  });

  it("hides its sidecar store from listings", async () => {
    const root = path.join(await makeTempRoot(), "root");
    const storage = new BYOC({ provider: new LocalFileSystemProvider({ rootDirectory: root }) });
    await storage.connect();
    try {
      await storage.upload("a.txt", Buffer.from("x"), { metadata: { k: "v" } });
      const names = (await storage.list()).map((item) => item.name);

      expect(names).toContain("a.txt");
      expect(names).not.toContain(".byoc");
    } finally {
      await storage.disconnect();
    }
  });

  it("can require the root to already exist", async () => {
    const missing = path.join(await makeTempRoot(), "does-not-exist");
    const provider = new LocalFileSystemProvider({ rootDirectory: missing, createRoot: false });

    expect(await errorCodeOf(() => provider.connect())).toBe(BYOCErrorCode.INVALID_INPUT);
  });
});

describe("MemoryProvider specifics", () => {
  it("exposes stored state through its test helpers", async () => {
    const provider = new MemoryProvider();
    const storage = new BYOC({ provider });
    await storage.connect();

    await storage.writeText("a.txt", "one");
    await storage.writeText("b.txt", "two");

    expect(provider.size).toBe(2);
    expect(Buffer.from(provider.snapshot()["a.txt"]!).toString()).toBe("one");

    provider.clear();
    expect(provider.size).toBe(0);
    expect(await storage.exists("a.txt")).toBe(false);
  });

  it("rejects a stream chunk size below one byte", () => {
    expect(() => new MemoryProvider({ streamChunkSize: 0 })).toThrow();
  });
});
