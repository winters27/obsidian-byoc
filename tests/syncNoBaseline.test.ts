import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";

// In-memory filesystem driving the real sync engine, mirroring the harness in
// syncConvergence.test.ts, with write/delete counters to prove non-transfer.
class MemFs extends FakeFs {
  kind: string;
  files = new Map<
    string,
    { content: ArrayBuffer; mtime: number; ctime: number; folder: boolean }
  >();
  writeCount = 0;
  rmCount = 0;

  constructor(kind: string) {
    super();
    this.kind = kind;
  }

  async walk(): Promise<any[]> {
    const out: any[] = [];
    for (const [key, f] of this.files) {
      if (f.folder) {
        out.push({ key, keyRaw: key, size: 0, sizeRaw: 0 });
      } else {
        out.push({
          key,
          keyRaw: key,
          mtimeCli: f.mtime,
          mtimeSvr: f.mtime,
          size: f.content.byteLength,
          sizeRaw: f.content.byteLength,
        });
      }
    }
    return out;
  }
  async walkPartial(): Promise<any[]> {
    return this.walk();
  }
  async stat(key: string): Promise<any> {
    const f = this.files.get(key);
    if (!f) throw new Error(`status 404 not found: ${key}`);
    const base = { key, keyRaw: key, mtimeCli: f.mtime, mtimeSvr: f.mtime, ctimeCli: f.ctime };
    return f.folder
      ? { ...base, size: 0, sizeRaw: 0 }
      : { ...base, size: f.content.byteLength, sizeRaw: f.content.byteLength };
  }
  async mkdir(key: string, mtime = 1, ctime = 1): Promise<any> {
    this.files.set(key, { content: new ArrayBuffer(0), mtime, ctime, folder: true });
    return { key, keyRaw: key, size: 0, sizeRaw: 0, mtimeCli: mtime, mtimeSvr: mtime };
  }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number): Promise<any> {
    this.writeCount++;
    this.files.set(key, { content, mtime, ctime, folder: false });
    return {
      key,
      keyRaw: key,
      mtimeCli: mtime,
      mtimeSvr: mtime,
      ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
    };
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    const f = this.files.get(key);
    if (!f) throw new Error(`status 404 not found: ${key}`);
    return f.content;
  }
  async rename(k1: string, k2: string): Promise<void> {
    const f = this.files.get(k1);
    if (!f) throw new Error(`status 404 ${k1}`);
    this.files.delete(k1);
    this.files.set(k2, f);
  }
  async rm(key: string): Promise<void> {
    this.rmCount++;
    this.files.delete(key);
  }
  supportsRename(): boolean {
    return true;
  }
  async checkConnect(): Promise<boolean> {
    return true;
  }
  async getUserDisplayName(): Promise<string> {
    return "test";
  }
  async revokeAuth(): Promise<void> {}
  allowEmptyFile(): boolean {
    return true;
  }

  put(key: string, body: string, mtime: number): void {
    this.files.set(key, {
      content: new TextEncoder().encode(body).buffer as ArrayBuffer,
      mtime,
      ctime: mtime,
      folder: false,
    });
  }
  putFolder(key: string, mtime: number): void {
    this.files.set(key, { content: new ArrayBuffer(0), mtime, ctime: mtime, folder: true });
  }
  read(key: string): string {
    const f = this.files.get(key);
    return f ? new TextDecoder().decode(f.content) : "";
  }
  fileKeys(): string[] {
    return [...this.files.keys()].filter((k) => !k.endsWith("/")).sort();
  }
}

function makeDb(seed?: any[]) {
  let store: any[] | undefined = seed;
  return {
    _get: () => store,
    prevSyncRecordsTbl: {
      async getItem() {
        return store;
      },
      async setItem(_id: string, v: any[]) {
        store = v;
      },
    },
  };
}

async function runSync(local: MemFs, remote: MemFs, db: any): Promise<void> {
  const settings: any = {
    password: "",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
  };
  let syncErr: Error | null = null;
  await syncer(
    local as any,
    remote as any,
    {} as any,
    undefined,
    db,
    "manual" as any,
    "profile1",
    "vault1",
    ".obsidian",
    settings,
    "1.0.0",
    async () => {},
    () => "",
    async () => {},
    async () => {},
    async (_s: any, err: Error) => {
      syncErr = err;
    },
    async () => {},
    async () => {},
    async () => {}
  );
  if (syncErr) throw syncErr;
}

function seedIdentical(local: MemFs, remote: MemFs): void {
  for (const fs of [local, remote]) {
    fs.putFolder("docs/", 1000);
    fs.put("docs/a.md", "alpha", 1000);
    fs.put("b.md", "bravo", 2000);
    fs.put("c.md", "charlie", 3000);
  }
}

describe("No-baseline sync onto an identical remote (#11)", () => {
  it("transfers nothing and does not trip protection when both sides already match", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    seedIdentical(local, remote);

    await runSync(local, remote, db);

    assert.equal(local.writeCount, 0, "nothing downloaded");
    assert.equal(remote.writeCount, 0, "nothing uploaded");
    assert.equal(local.rmCount + remote.rmCount, 0, "nothing deleted");
    assert.deepEqual(local.fileKeys(), ["b.md", "c.md", "docs/a.md"]);
    assert.deepEqual(local.fileKeys(), remote.fileKeys());
    assert.ok((db as any)._get()?.length > 0, "baseline adopted");
  });

  it("commits a complete baseline: the second sync is also a no-op", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    seedIdentical(local, remote);

    await runSync(local, remote, db);
    await runSync(local, remote, db);

    assert.equal(local.writeCount, 0);
    assert.equal(remote.writeCount, 0);
    assert.equal(local.rmCount + remote.rmCount, 0);
  });

  it("a genuinely different file still resolves as a conflict", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    seedIdentical(local, remote);
    local.put("d.md", "local version", 1000);
    remote.put("d.md", "remote version longer", 5_000_000);

    await runSync(local, remote, db);

    const extras = local.fileKeys().filter((k) => !["b.md", "c.md", "docs/a.md", "d.md"].includes(k));
    assert.equal(extras.length, 1, "exactly one conflict copy for the divergent file");
  });

  it("edits after adoption sync normally in both directions", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    seedIdentical(local, remote);
    await runSync(local, remote, db);

    local.put("b.md", "bravo edited", 10_000);
    remote.put("c.md", "charlie edited", 11_000);
    await runSync(local, remote, db);

    assert.equal(remote.read("b.md"), "bravo edited");
    assert.equal(local.read("c.md"), "charlie edited");
  });
});

describe("Empty-remote guard with existing history (#11 follow-up)", () => {
  it("refuses to plan mass local deletion when the remote comes back empty", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    local.put("b.md", "y", 2000);
    local.put("c.md", "z", 3000);
    await runSync(local, remote, db); // uploads, baseline set

    remote.files.clear(); // wrong folder, new account, or provider glitch

    await assert.rejects(
      () => runSync(local, remote, db),
      /remote returned no files/
    );
    assert.deepEqual(local.fileKeys(), ["a.md", "b.md", "c.md"], "local vault untouched");
    assert.ok(((db as any)._get() ?? []).length > 0, "baseline not clobbered");
  });

  it("still empties a tiny vault: one or two total deletions are below the floor", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    local.put("b.md", "y", 2000);
    await runSync(local, remote, db);

    remote.files.clear(); // genuine wipe of a two-file vault
    await runSync(local, remote, db);
    assert.deepEqual(local.fileKeys(), [], "both deletions applied");
  });

  it("still propagates a normal partial remote deletion", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    local.put("b.md", "y", 2000);
    await runSync(local, remote, db);

    remote.files.delete("a.md"); // deleted on another device
    await runSync(local, remote, db);
    assert.deepEqual(local.fileKeys(), ["b.md"], "the one deletion applied");
  });

  it("does not block a first sync into an empty remote", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);

    await runSync(local, remote, db); // no history: plain upload
    assert.deepEqual(remote.fileKeys(), ["a.md"]);
  });
});
