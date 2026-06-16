import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";

// Minimal in-memory filesystem for driving the real sync engine end to end,
// no cloud account needed. Used for both the "local" and "remote" sides.
class MemFs extends FakeFs {
  kind: string;
  files = new Map<
    string,
    { content: ArrayBuffer; mtime: number; ctime: number; folder: boolean }
  >();
  writeCount = 0;

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

  // test helpers
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
  keys(): string[] {
    return [...this.files.keys()].sort();
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
    {} as any, // fsEncrypt: unused because password === ""
    undefined,
    db,
    "manual" as any,
    "profile1",
    "vault1",
    ".obsidian",
    settings,
    "1.0.0",
    async () => {},
    () => "", // getProtectError: never trips
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

describe("Sync engine convergence (in-memory, no encryption)", () => {
  it("pushes a new file once and is stable on re-sync (no duplication or re-upload)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("note.md", "hello", 1000);

    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), ["note.md"]);
    assert.equal(remote.read("note.md"), "hello");
    const writesAfterFirst = remote.writeCount;

    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), ["note.md"]); // still one
    assert.equal(remote.writeCount, writesAfterFirst); // no redundant re-upload
  });

  it("propagates a local delete and does not resurrect it", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    await runSync(local, remote, db); // a.md on both, baseline set

    local.files.delete("a.md"); // user deletes locally
    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), []); // deleted on remote

    await runSync(local, remote, db);
    assert.deepEqual(local.fileKeys(), []); // does not come back
    assert.deepEqual(remote.fileKeys(), []);
  });

  it("moves a file without duplicating the old path (#1127)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a/note.md", "body", 1000);
    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), ["a/note.md"]);

    // move a/note.md -> b/note.md locally
    local.files.delete("a/note.md");
    local.put("b/note.md", "body", 1000);
    await runSync(local, remote, db);

    assert.deepEqual(remote.fileKeys(), ["b/note.md"]); // moved, not duplicated
    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), ["b/note.md"]); // stable, a/ does not reappear
  });

  it("deletes a folder and its contents without recreating them (#1127)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.putFolder("docs/", 1000);
    local.put("docs/x.md", "data", 1000);
    await runSync(local, remote, db);
    assert.deepEqual(remote.keys(), ["docs/", "docs/x.md"]);

    // delete the folder and its file locally
    local.files.delete("docs/x.md");
    local.files.delete("docs/");
    await runSync(local, remote, db);
    assert.deepEqual(remote.keys(), []); // gone on remote

    await runSync(local, remote, db);
    assert.deepEqual(local.keys(), []); // does not reappear locally
    assert.deepEqual(remote.keys(), []);
  });

  it("creates a single conflict copy and does not multiply it on re-sync (#1074)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("c.md", "base", 1000);
    await runSync(local, remote, db); // in sync

    // both sides diverge from baseline
    local.put("c.md", "local-edit", 2000);
    remote.put("c.md", "remote-edit-longer", 3000);

    await runSync(local, remote, db);
    const conflictsAfterFirst = local.fileKeys().filter((k) => k !== "c.md");
    assert.equal(conflictsAfterFirst.length, 1, "exactly one conflict copy");

    await runSync(local, remote, db);
    await runSync(local, remote, db);
    const conflictsAfterMore = local.fileKeys().filter((k) => k !== "c.md");
    assert.equal(conflictsAfterMore.length, 1, "conflict copy did not multiply");
  });
});
