import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";
import { loadPrevSyncRecords, prevSyncRecordsKey } from "../src/sync/baseline";

// In-memory filesystem driving the real sync engine, the same harness the other
// sync suites carry, with write/delete counters to prove what moved.
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
  fileKeys(): string[] {
    return [...this.files.keys()].filter((k) => !k.endsWith("/")).sort();
  }
}

// A prev-sync table that honours its keys, unlike the single-slot fakes in the
// other suites: this bug is entirely about which key a vault reads.
function makeKeyedDb(seed: Record<string, any[]> = {}) {
  const store = new Map<string, any[]>(Object.entries(seed));
  return {
    store,
    prevSyncRecordsTbl: {
      async getItem(k: string) {
        return store.has(k) ? store.get(k) : null;
      },
      async setItem(k: string, v: any[]) {
        store.set(k, v);
      },
      async removeItem(k: string) {
        store.delete(k);
      },
    },
  };
}

const PROFILE = "box-default-1";

async function runSync(local: MemFs, remote: MemFs, db: any, vaultID: string): Promise<void> {
  const settings: any = {
    password: "",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 50,
  };
  let syncErr: Error | null = null;
  await syncer(
    local as any,
    remote as any,
    {} as any,
    undefined,
    db,
    "manual" as any,
    PROFILE,
    vaultID,
    ".obsidian",
    settings,
    "1.0.18",
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

function seedVault(fs: MemFs): void {
  fs.putFolder("docs/", 1000);
  fs.put("docs/a.md", "alpha", 1000);
  fs.put("b.md", "bravo", 2000);
  fs.put("c.md", "charlie", 3000);
}

describe("Baseline is per vault, not per provider profile", () => {
  it("a second empty vault on the same machine pulls the remote instead of deleting it", async () => {
    const db = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, db, "vault-A");
    assert.deepEqual(remote.fileKeys(), ["b.md", "c.md", "docs/a.md"]);

    // The exact shape of the real-Box smoke on 2026-09-20: a fresh vault, same
    // provider, nothing synced yet. Before 1.0.18 it read vault A's baseline and
    // planned local_is_deleted_thus_also_delete_remote for every file.
    const vaultB = new MemFs("B");
    await runSync(vaultB, remote, db, "vault-B");

    assert.equal(remote.rmCount, 0, "nothing deleted on the remote");
    assert.deepEqual(remote.fileKeys(), ["b.md", "c.md", "docs/a.md"]);
    assert.deepEqual(vaultB.fileKeys(), ["b.md", "c.md", "docs/a.md"], "vault B pulled everything");
    assert.ok(db.store.has(prevSyncRecordsKey("vault-A", PROFILE)));
    assert.ok(db.store.has(prevSyncRecordsKey("vault-B", PROFILE)));
    assert.equal(db.store.has(PROFILE), false, "no machine-wide row is ever written");
  });

  it("the pre-1.0.18 shared row is adopted by the vault it describes and then removed", async () => {
    const db = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, db, "vault-A");

    // Move the baseline to where releases up to 1.0.17 kept it.
    const legacy = db.store.get(prevSyncRecordsKey("vault-A", PROFILE))!;
    db.store.clear();
    db.store.set(PROFILE, legacy);

    const writesBefore = { local: vaultA.writeCount, remote: remote.writeCount };
    await runSync(vaultA, remote, db, "vault-A");
    assert.equal(vaultA.writeCount, writesBefore.local, "idle sync wrote nothing locally");
    assert.equal(remote.writeCount, writesBefore.remote, "idle sync wrote nothing remotely");
    assert.equal(remote.rmCount + vaultA.rmCount, 0);
    assert.ok(db.store.has(prevSyncRecordsKey("vault-A", PROFILE)), "row now lives under the vault key");
    assert.equal(db.store.has(PROFILE), false, "legacy row removed after adoption");

    // The adopted baseline is a working one: a local deletion still propagates.
    vaultA.files.delete("b.md");
    await runSync(vaultA, remote, db, "vault-A");
    assert.deepEqual(remote.fileKeys(), ["c.md", "docs/a.md"]);
  });

  it("the shared row is left alone for a vault it does not describe", async () => {
    const db = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, db, "vault-A");
    const legacy = db.store.get(prevSyncRecordsKey("vault-A", PROFILE))!;
    db.store.clear();
    db.store.set(PROFILE, legacy);

    // An empty vault: zero of the three files exist here.
    const vaultB = new MemFs("B");
    await runSync(vaultB, remote, db, "vault-B");
    assert.equal(remote.rmCount, 0);
    assert.deepEqual(vaultB.fileKeys(), ["b.md", "c.md", "docs/a.md"]);
    assert.ok(db.store.has(PROFILE), "legacy row still waits for its owner");
    assert.ok(db.store.has(prevSyncRecordsKey("vault-B", PROFILE)));

    // A vault holding one of the three: below half, so still not adopted, and
    // the shared file is recognised as equal rather than fought over.
    const vaultC = new MemFs("C");
    vaultC.put("c.md", "charlie", 3000);
    await runSync(vaultC, remote, db, "vault-C");
    assert.equal(remote.rmCount, 0);
    assert.deepEqual(vaultC.fileKeys(), ["b.md", "c.md", "docs/a.md"]);
    assert.ok(db.store.has(PROFILE), "legacy row still present after a partial match");
  });

  it("an existing per-vault row wins and the legacy row is untouched", async () => {
    const own = [{ key: "x.md", keyRaw: "x.md", sizeRaw: 1 }];
    const legacy = [{ key: "y.md", keyRaw: "y.md", sizeRaw: 1 }];
    const db = makeKeyedDb({ [prevSyncRecordsKey("v", PROFILE)]: own, [PROFILE]: legacy });
    const got = await loadPrevSyncRecords(db.prevSyncRecordsTbl, "v", PROFILE, ["y.md"]);
    assert.deepEqual(got, own);
    assert.deepEqual(db.store.get(PROFILE), legacy);
  });

  it("a legacy row of folders only is never adopted", async () => {
    const legacy = [{ key: "docs/", keyRaw: "docs/", sizeRaw: 0 }];
    const db = makeKeyedDb({ [PROFILE]: legacy });
    const got = await loadPrevSyncRecords(db.prevSyncRecordsTbl, "v", PROFILE, ["docs/"]);
    assert.deepEqual(got, []);
    assert.ok(db.store.has(PROFILE));
  });
});
