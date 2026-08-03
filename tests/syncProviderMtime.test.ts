import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { syncer } from "../src/sync/syncer";
import { getFolderLevels } from "../src/misc";
import {
  fromS3ObjectToEntity,
  fromS3HeadObjectToEntity,
} from "../src/fsS3";
import { fromWebdavItemToEntity } from "../src/fsWebdav";

// Sync against a provider that cannot round-trip a client mtime.
//
// Every other account-free fake in this suite reports mtimeCli and mtimeSvr as
// the same value, which is a pCloud-shaped provider: the server stores the
// client mtime and hands it straight back. S3, WebDAV, Box, Yandex and Koofr do
// not. They report their own server clock, and S3 additionally synthesizes
// folders from object keys instead of storing folder objects.
//
// Those two differences are the entire point of this file. Client mtimes sit
// near CLIENT_BASE and server times near SERVER_BASE, decades apart, so any
// comparison that mixes the two anchors is unmistakable rather than a rounding
// artifact.

const CLIENT_BASE = 1_000_000_000_000; // ~2001, plausible note mtimes
const SERVER_BASE = 1_700_000_000_000; // ~2023, "when the upload happened"

interface StoredObject {
  content: ArrayBuffer;
  lastModified: number;
}

/**
 * The remote. Ignores the client mtime it is handed on write and reports its own
 * clock, exactly as S3's ListObjectsV2 does when useAccurateMTime is off.
 */
class LossyMtimeFs extends FakeFs {
  kind: string;
  objects = new Map<string, StoredObject>();
  synthFolders = new Map<string, number>();
  writeCount = 0;
  rmCount = 0;
  /**
   * false is the contract these providers now follow: no client mtime is
   * reported, because none was ever stored. true reproduces the older shape
   * where the server clock was echoed into mtimeCli.
   */
  fabricateMtimeCli: boolean;
  canRename: boolean;
  private clock = SERVER_BASE;

  constructor(
    kind = "lossy",
    fabricateMtimeCli = false,
    canRename = false
  ) {
    super();
    this.kind = kind;
    this.fabricateMtimeCli = fabricateMtimeCli;
    this.canRename = canRename;
  }

  /** Whole seconds, like S3's LastModified. */
  private tick(): number {
    this.clock += 60_000;
    return Math.floor(this.clock / 1000) * 1000;
  }

  private fileEntity(key: string, o: StoredObject): any {
    return {
      key,
      keyRaw: key,
      mtimeSvr: o.lastModified,
      mtimeCli: this.fabricateMtimeCli ? o.lastModified : undefined,
      size: o.content.byteLength,
      sizeRaw: o.content.byteLength,
    };
  }

  async walk(): Promise<any[]> {
    const res: any[] = [];
    const synth = new Map<string, number>(this.synthFolders);
    for (const [key, o] of this.objects) {
      res.push(this.fileEntity(key, o));
      for (const f of getFolderLevels(key, true)) {
        const prev = synth.get(f);
        if (prev === undefined || o.lastModified >= prev) {
          synth.set(f, o.lastModified);
        }
      }
    }
    for (const [key, mtime] of synth) {
      res.push({
        key,
        keyRaw: key,
        size: 0,
        sizeRaw: 0,
        sizeEnc: 0,
        mtimeSvr: mtime,
        mtimeCli: this.fabricateMtimeCli ? mtime : undefined,
        synthesizedFolder: true,
      });
    }
    return res;
  }

  async walkPartial(): Promise<any[]> {
    return this.walk();
  }

  async stat(key: string): Promise<any> {
    if (key.endsWith("/")) {
      const all = await this.walk();
      const hit = all.find((e) => e.keyRaw === key);
      if (!hit) throw new Error(`status 404 not found: ${key}`);
      return hit;
    }
    const o = this.objects.get(key);
    if (!o) throw new Error(`status 404 not found: ${key}`);
    return this.fileEntity(key, o);
  }

  // Folders are never materialised, matching S3 with generateFolderObject off.
  // The entity is stamped with the caller's LOCAL mtime, which is what makes the
  // baseline disagree with the next walk.
  async mkdir(key: string, mtime = 1, _ctime = 1): Promise<any> {
    this.synthFolders.set(key, mtime);
    return {
      key,
      keyRaw: key,
      size: 0,
      sizeRaw: 0,
      sizeEnc: 0,
      mtimeSvr: mtime,
      mtimeCli: mtime,
      synthesizedFolder: true,
    };
  }

  /** Simulates the app restart that empties S3's in-memory synthFoldersCache. */
  forgetSynthFolders(): void {
    this.synthFolders.clear();
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    _mtime: number,
    _ctime: number
  ): Promise<any> {
    this.writeCount++;
    const o = { content, lastModified: this.tick() };
    this.objects.set(key, o);
    return this.fileEntity(key, o);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`status 404 not found: ${key}`);
    return o.content;
  }

  async rename(k1: string, k2: string): Promise<void> {
    const o = this.objects.get(k1);
    if (!o) throw new Error(`status 404 ${k1}`);
    this.objects.delete(k1);
    this.objects.set(k2, o);
  }

  async rm(key: string): Promise<void> {
    this.rmCount++;
    this.objects.delete(key);
    this.synthFolders.delete(key);
  }

  supportsRename(): boolean {
    return this.canRename;
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

  // helpers
  put(key: string, body: string): void {
    const u = new TextEncoder().encode(body);
    this.objects.set(key, {
      content: u.buffer.slice(0, u.byteLength),
      lastModified: this.tick(),
    });
  }
  objectKeys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

/**
 * The local side, mirroring FakeFsLocal's entity shape: files carry mtimeCli AND
 * mtimeSvr (both the local mtime), folders carry neither from walk but do from
 * stat. Reproducing that faithfully is what lets this file see the baseline
 * anchor being overwritten.
 */
class LocalFs extends FakeFs {
  kind = "local";
  files = new Map<string, { content: ArrayBuffer; mtime: number }>();
  folders = new Set<string>();
  writeCount = 0;
  rmCount = 0;

  async walk(): Promise<any[]> {
    const res: any[] = [];
    for (const key of this.folders) {
      res.push({ key, keyRaw: key, size: 0, sizeRaw: 0 });
    }
    for (const [key, f] of this.files) {
      res.push({
        key,
        keyRaw: key,
        mtimeCli: f.mtime,
        mtimeSvr: f.mtime,
        size: f.content.byteLength,
        sizeRaw: f.content.byteLength,
      });
    }
    return res;
  }
  async walkPartial(): Promise<any[]> {
    return this.walk();
  }
  async stat(key: string): Promise<any> {
    if (key.endsWith("/")) {
      if (!this.folders.has(key)) throw new Error(`404 ${key}`);
      return {
        key,
        keyRaw: key,
        mtimeCli: CLIENT_BASE,
        mtimeSvr: CLIENT_BASE,
        ctimeCli: CLIENT_BASE,
        size: 0,
        sizeRaw: 0,
      };
    }
    const f = this.files.get(key);
    if (!f) throw new Error(`404 ${key}`);
    return {
      key,
      keyRaw: key,
      mtimeCli: f.mtime,
      mtimeSvr: f.mtime,
      ctimeCli: f.mtime,
      size: f.content.byteLength,
      sizeRaw: f.content.byteLength,
    };
  }
  async mkdir(key: string, _mtime?: number, _ctime?: number): Promise<any> {
    this.folders.add(key);
    return this.stat(key);
  }
  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    _ctime: number
  ): Promise<any> {
    this.writeCount++;
    this.files.set(key, { content, mtime });
    return this.stat(key);
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    const f = this.files.get(key);
    if (!f) throw new Error(`404 ${key}`);
    return f.content;
  }
  async rename(k1: string, k2: string): Promise<void> {
    const f = this.files.get(k1);
    if (!f) throw new Error(`404 ${k1}`);
    this.files.delete(k1);
    this.files.set(k2, f);
  }
  async rm(key: string): Promise<void> {
    this.rmCount++;
    this.files.delete(key);
    this.folders.delete(key);
  }
  supportsRename(): boolean {
    return false;
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

  // helpers
  put(key: string, body: string, mtime: number): void {
    const u = new TextEncoder().encode(body);
    this.files.set(key, { content: u.buffer.slice(0, u.byteLength), mtime });
    for (const f of getFolderLevels(key, true)) {
      this.folders.add(f);
    }
  }
  read(key: string): string {
    const f = this.files.get(key);
    return f ? new TextDecoder().decode(f.content) : "";
  }
  fileKeys(): string[] {
    return [...this.files.keys()].sort();
  }
}

function makeDb(seed?: any[]) {
  let store: any[] | undefined = seed;
  return {
    prevSyncRecordsTbl: {
      async getItem() {
        return store;
      },
      async setItem(_id: string, v: any[]) {
        store = v;
      },
    },
    _get(): any[] {
      return store ?? [];
    },
  } as any;
}

// Mirrors main.ts's getProtectError so the tests exercise the real arithmetic
// rather than a stub that always passes.
function realProtectError(
  protectModifyPercentage: number,
  realModifyDeleteCount: number,
  allFilesCount: number
): string {
  const percentNum = (100 * realModifyDeleteCount) / allFilesCount;
  if (percentNum < protectModifyPercentage) {
    return "";
  }
  return `blocked ${realModifyDeleteCount}/${allFilesCount} (${percentNum.toFixed(1)}%)`;
}

function baseSettings(overrides: any = {}): any {
  return {
    password: "",
    encryptionMethod: "openssl-base64",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
    encryptionFixSafetyDone: true,
    svrAnchorFixDone: true,
    ...overrides,
  };
}

interface RunResult {
  decisions: string[];
  notifications: string[];
}

/**
 * One sync. `settings` is passed in by the caller and reused across runs on
 * purpose: building a fresh object per sync would reset the one-time migration
 * flags and hide exactly the behaviour the migration tests assert.
 */
async function runSync(
  local: LocalFs,
  remote: LossyMtimeFs,
  db: any,
  settings: any,
  opts: { protect?: number } = {}
): Promise<RunResult> {
  const password = settings.password ?? "";
  const fsEncrypt = new FakeFsEncrypt(
    remote as any,
    password,
    settings.encryptionMethod ?? "openssl-base64"
  );
  const decisions: string[] = [];
  const notifications: string[] = [];
  await syncer(
    local as any,
    remote as any,
    fsEncrypt as any,
    undefined,
    db,
    "manual" as any,
    "p1",
    "vault1",
    ".obsidian",
    settings,
    "1.0.0",
    async () => {},
    opts.protect === undefined
      ? () => ""
      : (_p: number, n: number, all: number) =>
          realProtectError(opts.protect!, n, all),
    async () => {},
    async () => {},
    async (_s: any, e: Error) => {
      notifications.push(e.message);
    },
    async () => {},
    async () => {},
    async (_s: any, _i: number, _t: number, key: string, decision: string) => {
      decisions.push(`${decision}:${key}`);
    }
  );
  return { decisions, notifications };
}

function seedVault(local: LocalFs): void {
  local.put("root.md", "root note", CLIENT_BASE);
  local.put("notes/a.md", "note a", CLIENT_BASE + 1000);
  local.put("notes/deep/b.md", "note b", CLIENT_BASE + 2000);
}

describe("Sync against a provider that loses the client mtime", () => {
  before(function () {
    (global as any).window = { crypto: require("crypto").webcrypto };
    (global as any).activeWindow = (global as any).window;
  });

  it("is a no-op across four consecutive syncs of an unchanged vault (unencrypted)", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);

    await runSync(local, remote, db, settings);
    assert.equal(remote.objectKeys().length, 3, "three objects uploaded");

    for (const n of [2, 3, 4]) {
      const res = await runSync(local, remote, db, settings);
      assert.deepEqual(res.decisions, [], `sync ${n} must do nothing`);
    }
    assert.equal(local.rmCount, 0, "no local deletions");
    assert.equal(local.writeCount, 0, "no redundant local writes");
    assert.equal(remote.writeCount, 3, "no redundant re-uploads");
  });

  it("is a no-op across four consecutive syncs of an unchanged vault (encrypted)", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings({ password: "hunter2" });
    seedVault(local);

    await runSync(local, remote, db, settings);
    // openssl-base64 is not folder aware, so each folder is stored as its own
    // encrypted object alongside the three files.
    assert.equal(remote.objectKeys().length, 5, "encrypted objects uploaded");

    for (const n of [2, 3, 4]) {
      const res = await runSync(local, remote, db, settings);
      assert.deepEqual(res.decisions, [], `encrypted sync ${n} must do nothing`);
    }
    assert.equal(local.rmCount, 0, "no local deletions");
    assert.equal(local.fileKeys().length, 3, "all local files survive");
  });

  it("never trips deletion protection on an unchanged vault", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings({ protectModifyPercentage: 50 });
    seedVault(local);

    for (const n of [1, 2, 3, 4]) {
      const res = await runSync(local, remote, db, settings, { protect: 50 });
      assert.deepEqual(
        res.notifications.filter((m) => m.includes("Protection")),
        [],
        `sync ${n} must not trip protection`
      );
    }
  });

  it("keeps the remote mtime anchor in the baseline after an unchanged sync", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);

    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    const row = db._get().find((e: any) => e.keyRaw === "root.md");
    assert.ok(row, "baseline row exists for root.md");
    const remoteEntity = await remote.stat("root.md");
    assert.equal(
      row.mtimeSvr,
      remoteEntity.mtimeSvr,
      "baseline mtimeSvr must hold the remote clock, not the local mtime"
    );
    assert.ok(
      row.mtimeSvr >= SERVER_BASE,
      `baseline mtimeSvr ${row.mtimeSvr} was overwritten with a local timestamp`
    );
  });

  it("still pulls a genuine remote modification", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    remote.put("root.md", "root note edited on another device");
    const res = await runSync(local, remote, db, settings);
    assert.deepEqual(res.decisions, ["remote_is_modified_then_pull:root.md"]);
    assert.equal(local.read("root.md"), "root note edited on another device");
  });

  it("still pulls a remote modification that did not change the byte length", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    // Same length, different bytes: only a timestamp can reveal this.
    remote.put("root.md", "ROOT NOTE");
    const res = await runSync(local, remote, db, settings);
    assert.deepEqual(res.decisions, ["remote_is_modified_then_pull:root.md"]);
    assert.equal(local.read("root.md"), "ROOT NOTE");
  });

  it("still applies a genuine remote deletion locally", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    await remote.rm("root.md");
    const res = await runSync(local, remote, db, settings);
    assert.deepEqual(res.decisions, [
      "remote_is_deleted_thus_also_delete_local:root.md",
    ]);
    assert.ok(!local.fileKeys().includes("root.md"), "local copy removed");
  });

  for (const conflictAction of ["smart_conflict", "keep_newer"]) {
    it(`propagates a local deletion without resurrecting it (${conflictAction})`, async () => {
      const local = new LocalFs();
      const remote = new LossyMtimeFs();
      const db = makeDb();
      const settings = baseSettings({ conflictAction });
      seedVault(local);
      await runSync(local, remote, db, settings);
      await runSync(local, remote, db, settings);

      await local.rm("root.md");
      const res = await runSync(local, remote, db, settings);
      assert.deepEqual(res.decisions, [
        "local_is_deleted_thus_also_delete_remote:root.md",
      ]);
      assert.ok(
        !remote.objectKeys().includes("root.md"),
        "remote object removed"
      );

      const again = await runSync(local, remote, db, settings);
      assert.deepEqual(again.decisions, [], "deletion stays deleted");
      assert.ok(
        !local.fileKeys().includes("root.md"),
        "file was not resurrected"
      );
    });
  }

  it("keeps an empty folder that the remote cannot represent after a restart", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    local.folders.add("Attachments/");

    await runSync(local, remote, db, settings);
    // The provider stores no folder objects; an app restart loses the cache.
    remote.forgetSynthFolders();

    const res = await runSync(local, remote, db, settings);
    assert.ok(
      !res.decisions.some((d) => d.includes("Attachments/") && d.includes("delete")),
      `empty folder must not be deleted, got ${JSON.stringify(res.decisions)}`
    );
    assert.ok(
      local.folders.has("Attachments/"),
      "the local empty folder still exists"
    );
  });

  it("still propagates a genuine remote folder deletion", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs("lossy-real-folders");
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    // Another device removed notes/deep/ and everything in it.
    await remote.rm("notes/deep/b.md");
    const res = await runSync(local, remote, db, settings);
    assert.ok(
      res.decisions.includes("remote_is_deleted_thus_also_delete_local:notes/deep/b.md"),
      `contained file must be deleted, got ${JSON.stringify(res.decisions)}`
    );
  });

  it("drops the baseline row for a file deleted on both sides, so re-creating it is safe", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);
    await runSync(local, remote, db, settings);

    await local.rm("root.md");
    await runSync(local, remote, db, settings); // propagates the delete
    await runSync(local, remote, db, settings); // settles

    assert.ok(
      !db._get().some((e: any) => e.keyRaw === "root.md"),
      "baseline row for the deleted file must not linger"
    );

    // Re-create at the same path with the same byte length as the original.
    local.put("root.md", "root note", CLIENT_BASE + 9000);
    const res = await runSync(local, remote, db, settings);
    assert.ok(
      !res.decisions.some((d) => d.startsWith("remote_is_deleted")),
      `re-created file must not be deleted, got ${JSON.stringify(res.decisions)}`
    );
    assert.ok(local.fileKeys().includes("root.md"), "re-created file survives");
  });

  it("heals a baseline poisoned by an older release without pulling anything", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);

    // Rewrite the baseline the way releases up to 1.0.13 did: mtimeSvr holding
    // the LOCAL mtime instead of the provider's clock.
    const poisoned = db._get().map((e: any) => ({
      ...e,
      mtimeSvr: e.mtimeCli ?? CLIENT_BASE,
    }));
    await db.prevSyncRecordsTbl.setItem("p1", poisoned);

    const healSettings = baseSettings({ svrAnchorFixDone: false });
    const writesBefore = local.writeCount;
    const res = await runSync(local, remote, db, healSettings, { protect: 50 });

    assert.deepEqual(res.decisions, [], "the heal sync must not plan any action");
    assert.equal(
      local.writeCount,
      writesBefore,
      "the heal must not pull anything"
    );
    assert.equal(
      healSettings.svrAnchorFixDone,
      true,
      "the one-time flag must be recorded"
    );

    const after = await runSync(local, remote, db, healSettings);
    assert.deepEqual(after.decisions, [], "and it stays settled");
  });

  it("does not re-anchor a row whose remote content changed size", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);

    const poisoned = db._get().map((e: any) => ({
      ...e,
      mtimeSvr: e.mtimeCli ?? CLIENT_BASE,
    }));
    await db.prevSyncRecordsTbl.setItem("p1", poisoned);

    // An edit landed on the remote while the user was stuck.
    remote.put("root.md", "root note, edited elsewhere");

    const healSettings = baseSettings({ svrAnchorFixDone: false });
    const res = await runSync(local, remote, db, healSettings);
    assert.ok(
      res.decisions.includes("remote_is_modified_then_pull:root.md"),
      `the real edit must still be pulled, got ${JSON.stringify(res.decisions)}`
    );
    assert.equal(local.read("root.md"), "root note, edited elsewhere");
  });

  it("does not re-anchor a row that was never poisoned", async () => {
    const local = new LocalFs();
    const remote = new LossyMtimeFs();
    const db = makeDb();
    const settings = baseSettings();
    seedVault(local);
    await runSync(local, remote, db, settings);

    // Baseline left exactly as the push wrote it: mtimeSvr holds the server
    // clock and mtimeCli the local mtime, so the row carries no stale anchor.
    // A same-length remote edit must still be detected during the heal sync.
    remote.put("root.md", "ROOT NOTE");

    const healSettings = baseSettings({ svrAnchorFixDone: false });
    const res = await runSync(local, remote, db, healSettings);
    assert.ok(
      res.decisions.includes("remote_is_modified_then_pull:root.md"),
      `a correctly anchored row must not be re-anchored, got ${JSON.stringify(res.decisions)}`
    );
    assert.equal(local.read("root.md"), "ROOT NOTE");
  });
});

// The integration suite above drives a fake, so it cannot tell whether the real
// providers actually follow the contract. These assert the builders directly.
describe("Provider entity builders and the client-mtime contract", () => {
  const s3Object = (key: string, size = 10) =>
    ({
      Key: key,
      Size: size,
      LastModified: new Date(SERVER_BASE),
      ETag: '"abc"',
    }) as any;

  it("S3 list: reports no client mtime when the object carries none", () => {
    const e = fromS3ObjectToEntity(s3Object("note.md"), "", {}, {});
    assert.equal(
      e.mtimeCli,
      undefined,
      "LastModified is the upload time, not a client mtime"
    );
    assert.equal(e.mtimeSvr, SERVER_BASE, "server anchor still reported");
  });

  it("S3 list: still reports the client mtime recorded in object metadata", () => {
    // useAccurateMTime populates mtimeRecords from x-amz-meta-mtime (seconds).
    const e = fromS3ObjectToEntity(
      s3Object("note.md"),
      "",
      { "note.md": CLIENT_BASE / 1000 },
      {}
    );
    assert.equal(
      e.mtimeCli,
      CLIENT_BASE,
      "a real stored client mtime must survive"
    );
  });

  it("S3 head: reports no client mtime unless accurate mtime is on", () => {
    const head = { ContentLength: 10, LastModified: new Date(SERVER_BASE) } as any;
    assert.equal(
      fromS3HeadObjectToEntity("note.md", head, "", false).mtimeCli,
      undefined
    );

    const headWithMeta = {
      ContentLength: 10,
      LastModified: new Date(SERVER_BASE),
      Metadata: { mtime: `${CLIENT_BASE / 1000}` },
    } as any;
    assert.equal(
      fromS3HeadObjectToEntity("note.md", headWithMeta, "", true).mtimeCli,
      CLIENT_BASE,
      "a real stored client mtime must survive"
    );
  });

  it("WebDAV: reports no client mtime, since it cannot store one", () => {
    const e = fromWebdavItemToEntity(
      {
        filename: "/vault/note.md",
        basename: "note.md",
        lastmod: new Date(SERVER_BASE).toUTCString(),
        size: 10,
        type: "file",
        etag: null,
      } as any,
      "vault"
    );
    assert.equal(e.mtimeCli, undefined);
    assert.ok(e.mtimeSvr !== undefined, "server anchor still reported");
  });
});
