import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";

// In-memory filesystem mirroring the harness in syncConvergence.test.ts.
// The local side can also carry problematicKeys, the way FakeFsLocal reports
// entries it saw but could not read (issue #10, broken symlinks).
class MemFs extends FakeFs {
  kind: string;
  files = new Map<
    string,
    { content: ArrayBuffer; mtime: number; ctime: number; folder: boolean }
  >();
  writeCount = 0;
  rmCount = 0;
  problematicKeys: string[] = [];

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

function baselineRow(key: string, mtime: number, size: number): any {
  return { key, keyRaw: key, mtimeCli: mtime, mtimeSvr: mtime, size, sizeRaw: size };
}

// The syncer reports the "held N operations" hold through the error-notice
// channel the way the undecryptable-entry guard does; that is informational,
// so collect it instead of failing the run. Anything else is a real error.
async function runSync(
  local: MemFs,
  remote: MemFs,
  db: any,
  localPathStillExists?: (key: string) => Promise<boolean>
): Promise<string[]> {
  const settings: any = {
    password: "",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
  };
  const notices: string[] = [];
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
      if (/could not be read/.test(err.message)) {
        notices.push(err.message);
      } else {
        syncErr = err;
      }
    },
    async () => {},
    async () => {},
    async () => {},
    undefined,
    localPathStillExists
  );
  if (syncErr) throw syncErr;
  return notices;
}

function row(db: any, key: string): any {
  return ((db as any)._get() ?? []).find((e: any) => e.keyRaw === key);
}

describe("Unreadable local entries are held, not misread (#10)", () => {
  it("does not delete the remote copy of a key the local walk could not read", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb([baselineRow("link.md", 1000, 1)]);
    remote.put("link.md", "x", 1000);
    local.problematicKeys = ["link.md"]; // seen but unreadable, absent from walk

    const notices = await runSync(local, remote, db);

    assert.deepEqual(remote.fileKeys(), ["link.md"], "remote copy survives");
    assert.equal(remote.rmCount, 0);
    assert.deepEqual(row(db, "link.md"), baselineRow("link.md", 1000, 1), "baseline row untouched");
    assert.equal(notices.length, 1, "the hold was surfaced to the user");
  });

  it("does not pull a modified remote over an unreadable local entry, and keeps the old anchors", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb([baselineRow("link.md", 1000, 1)]);
    remote.put("link.md", "changed remotely", 5_000_000);
    local.problematicKeys = ["link.md"];

    await runSync(local, remote, db);

    assert.equal(local.writeCount, 0, "nothing downloaded");
    assert.deepEqual(row(db, "link.md"), baselineRow("link.md", 1000, 1), "old anchors kept");
  });

  it("does not download over an unreadable local entry that has no baseline", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    remote.put("link.md", "remote body", 1000);
    local.problematicKeys = ["link.md"];

    await runSync(local, remote, db);

    assert.equal(local.writeCount, 0, "nothing downloaded");
    assert.equal(row(db, "link.md"), undefined, "no baseline fabricated");
  });

  it("positive control: without the problematic flag the same states delete and pull", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb([baselineRow("link.md", 1000, 1)]);
    remote.put("link.md", "x", 1000);

    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), [], "genuine local deletion propagates");

    const local2 = new MemFs("local");
    const remote2 = new MemFs("remote");
    const db2 = makeDb();
    remote2.put("new.md", "remote body", 1000);
    await runSync(local2, remote2, db2);
    assert.equal(local2.read("new.md"), "remote body", "genuine remote creation pulls");
  });
});

describe("Paths still on disk are not deleted remotely (#10)", () => {
  it("skips the remote delete when the path still exists outside Obsidian's index", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("CLAUDE.md", "shared instructions", 1000);
    await runSync(local, remote, db); // uploaded, baseline set

    local.files.delete("CLAUDE.md"); // index drops it: dangling symlink
    const asked: string[] = [];
    await runSync(local, remote, db, async (key) => {
      asked.push(key);
      return true; // lstat says the path is still there
    });

    assert.deepEqual(asked, ["CLAUDE.md"], "the disk was consulted");
    assert.deepEqual(remote.fileKeys(), ["CLAUDE.md"], "remote copy survives");
    assert.ok(row(db, "CLAUDE.md") !== undefined, "baseline row kept");
  });

  it("still deletes remotely when the disk confirms the path is gone", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("note.md", "body", 1000);
    await runSync(local, remote, db);

    local.files.delete("note.md");
    await runSync(local, remote, db, async () => false); // lstat: ENOENT

    assert.deepEqual(remote.fileKeys(), [], "genuine deletion propagates");
    assert.equal(row(db, "note.md"), undefined, "baseline row cleared");
  });
});
