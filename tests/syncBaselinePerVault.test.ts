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
function makeKeyedDb(seed: Record<string, any> = {}, withPlans = false) {
  const store = new Map<string, any>(Object.entries(seed));
  const plans = new Map<string, any>();
  return {
    store,
    plans,
    prevSyncRecordsTbl: {
      async getItem(k: string) {
        return store.has(k) ? store.get(k) : null;
      },
      async setItem(k: string, v: any) {
        store.set(k, v);
      },
      async removeItem(k: string) {
        store.delete(k);
      },
      async keys() {
        return [...store.keys()];
      },
    },
    syncPlansTbl: withPlans
      ? {
          async setItem(k: string, v: any) {
            plans.set(k, v);
          },
        }
      : undefined,
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

// Remotely Save keeps one row per file under "<vault>\t<profile>\t<key>", in
// the same database, holding the remote entity with the local mtime filled in.
function seedRemotelySaveRows(db: ReturnType<typeof makeKeyedDb>, vaultID: string, rows: any[]) {
  for (const r of rows) db.store.set(`${vaultID}\t${PROFILE}\t${r.keyRaw}`, r);
}

describe("Remotely Save history is inherited", () => {
  it("a vault switching over keeps its baseline: nothing transfers and a deletion propagates", async () => {
    // Build a genuine baseline by syncing once, then present it the way
    // Remotely Save would have left it and forget BYOC's own row.
    const seedDb = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, seedDb, "vault-A");
    const rows = seedDb.store.get(prevSyncRecordsKey("vault-A", PROFILE))!;

    const db = makeKeyedDb();
    seedRemotelySaveRows(db, "vault-A", rows);

    // A note deleted locally between the last Remotely Save sync and the first
    // BYOC sync. Only a baseline can tell "deleted here" from "new on the
    // remote": with the inherited rows the remote copy goes, without them the
    // note would be pulled straight back.
    vaultA.files.delete("b.md");
    const writesBefore = { local: vaultA.writeCount, remote: remote.writeCount };
    await runSync(vaultA, remote, db, "vault-A");
    assert.deepEqual(remote.fileKeys(), ["c.md", "docs/a.md"], "the deletion reached the remote");
    assert.deepEqual(vaultA.fileKeys(), ["c.md", "docs/a.md"], "the note was not pulled back");
    assert.equal(vaultA.writeCount, writesBefore.local, "nothing else transferred");
    assert.equal(remote.writeCount, writesBefore.remote);
    assert.ok(db.store.has(prevSyncRecordsKey("vault-A", PROFILE)), "copied into BYOC's own row");
    for (const r of rows) {
      assert.ok(db.store.has(`vault-A\t${PROFILE}\t${r.keyRaw}`), "Remotely Save's rows are left in place");
    }
  });

  it("rows for a different vault id or profile are never read", async () => {
    const seedDb = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, seedDb, "vault-A");
    const rows = seedDb.store.get(prevSyncRecordsKey("vault-A", PROFILE))!;

    const db = makeKeyedDb();
    seedRemotelySaveRows(db, "vault-OTHER", rows);
    for (const r of rows) db.store.set(`vault-A\tdropbox-default-1\t${r.keyRaw}`, r);

    const got = await loadPrevSyncRecords(db.prevSyncRecordsTbl, "vault-A", PROFILE, vaultA.fileKeys());
    assert.deepEqual(got, []);
    assert.equal(db.store.has(prevSyncRecordsKey("vault-A", PROFILE)), false);
  });

  it("rows that describe files no longer here are left alone", async () => {
    const seedDb = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, seedDb, "vault-A");
    const rows = seedDb.store.get(prevSyncRecordsKey("vault-A", PROFILE))!;

    const db = makeKeyedDb();
    seedRemotelySaveRows(db, "vault-A", rows);
    const got = await loadPrevSyncRecords(db.prevSyncRecordsTbl, "vault-A", PROFILE, ["c.md"]);
    assert.deepEqual(got, [], "one of three files present is below half");
    assert.equal(db.store.has(prevSyncRecordsKey("vault-A", PROFILE)), false);
  });

  it("the pre-1.0.18 BYOC row outranks Remotely Save's rows", async () => {
    const legacy = [{ key: "x.md", keyRaw: "x.md", sizeRaw: 1 }];
    const rs = { key: "x.md", keyRaw: "x.md", sizeRaw: 99 };
    const db = makeKeyedDb({ [PROFILE]: legacy, [`v\t${PROFILE}\tx.md`]: rs });
    const got = await loadPrevSyncRecords(db.prevSyncRecordsTbl, "v", PROFILE, ["x.md"]);
    assert.deepEqual(got, legacy);
    assert.equal(db.store.has(PROFILE), false, "adopted and removed");
    assert.ok(db.store.has(`v\t${PROFILE}\tx.md`), "Remotely Save row untouched");
  });

  it("a table that cannot list keys simply has no history to inherit", async () => {
    const tbl = {
      async getItem() {
        return null;
      },
      async setItem() {},
      async removeItem() {},
    };
    const got = await loadPrevSyncRecords(tbl, "v", PROFILE, ["x.md"]);
    assert.deepEqual(got, []);
  });
});

describe("Sync plan history is recorded for the exporter", () => {
  it("every sync stores one plan under the vault key, with a change flag per entry", async () => {
    const db = makeKeyedDb({}, true);
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, db, "vault-A");
    await runSync(vaultA, remote, db, "vault-A");

    const keys = [...db.plans.keys()];
    assert.equal(keys.length, 2, "one record per sync");
    assert.ok(keys.every((k) => k.startsWith("vault-A\t")), "keyed by vault, the prefix the exporter filters on");

    const records = keys.map((k) => db.plans.get(k)).sort((a, b) => a.ts - b.ts);
    for (const rec of records) {
      assert.equal(rec.vaultRandomID, "vault-A");
      assert.equal(typeof rec.syncPlan, "string");
    }
    const first = JSON.parse(records[0].syncPlan);
    const second = JSON.parse(records[1].syncPlan);
    assert.equal(first["/$@meta"].triggerSource, "manual");
    assert.equal(first["b.md"].decision, "local_is_created_then_push");
    assert.equal(first["b.md"].change, true);
    assert.equal(second["b.md"].decision, "equal");
    assert.equal(second["b.md"].change, false);
    // What the exporter's "change part" view would keep from each plan.
    const changed = (p: any) => Object.entries(p).filter(([k, v]: any) => k !== "/$@meta" && v.change === true).length;
    assert.equal(changed(first), 4);
    assert.equal(changed(second), 0);
  });

  it("a sync without a plans table still runs", async () => {
    const db = makeKeyedDb();
    const remote = new MemFs("remote");
    const vaultA = new MemFs("A");
    seedVault(vaultA);
    await runSync(vaultA, remote, db, "vault-A");
    assert.deepEqual(remote.fileKeys(), ["b.md", "c.md", "docs/a.md"]);
  });
});
