import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";

// In-memory filesystem that records every mutating call, so a test can assert
// a dry run issued none of them. Same shape as the MemFs in
// syncConvergence.test.ts, plus the ops log.
class MemFs extends FakeFs {
  kind: string;
  files = new Map<
    string,
    { content: ArrayBuffer; mtime: number; ctime: number; folder: boolean }
  >();
  ops: string[] = [];

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
    this.ops.push(`mkdir:${key}`);
    this.files.set(key, { content: new ArrayBuffer(0), mtime, ctime, folder: true });
    return { key, keyRaw: key, size: 0, sizeRaw: 0, mtimeCli: mtime, mtimeSvr: mtime };
  }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number): Promise<any> {
    this.ops.push(`write:${key}`);
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
    this.ops.push(`rename:${k1}->${k2}`);
    const f = this.files.get(k1);
    if (!f) throw new Error(`status 404 ${k1}`);
    this.files.delete(k1);
    this.files.set(k2, f);
  }
  async rm(key: string): Promise<void> {
    this.ops.push(`rm:${key}`);
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

function makeSettings(): any {
  return {
    password: "",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
    svrAnchorFixDone: false,
    encryptionFixSafetyDone: false,
  };
}

async function runSync(
  triggerSource: "manual" | "dry",
  local: MemFs,
  remote: MemFs,
  db: any,
  settings: any,
  captured?: {
    notifySteps?: number[];
    summary?: { byDecision: Record<string, number>; totalPlanned: number } | null;
  }
): Promise<void> {
  let syncErr: Error | null = null;
  await syncer(
    local as any,
    remote as any,
    {} as any, // fsEncrypt: unused because password === ""
    undefined,
    db,
    triggerSource as any,
    "profile1",
    "vault1",
    ".obsidian",
    settings,
    "1.0.0",
    async () => {},
    () => "", // getProtectError: never trips
    async () => {},
    async (_s: any, step: number) => {
      captured?.notifySteps?.push(step);
    },
    async (_s: any, err: Error) => {
      syncErr = err;
    },
    async () => {},
    async () => {},
    async () => {},
    async (byDecision: Record<string, number>, totalPlanned: number) => {
      if (captured) captured.summary = { byDecision, totalPlanned };
    }
  );
  if (syncErr) throw syncErr;
}

describe("Dry run executes nothing (issue #7)", () => {
  it("plans but never touches either side, the baseline, or the migration flags", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    const settings = makeSettings();

    // Establish a real baseline first.
    local.put("a.md", "base-a", 1000);
    local.put("b.md", "base-b", 1000);
    local.put("c.md", "base-c", 1000);
    await runSync("manual", local, remote, db, settings);
    assert.deepEqual(remote.fileKeys(), ["a.md", "b.md", "c.md"]);

    // Diverge in three ways: remote edit, local edit, local delete.
    remote.put("a.md", "remote-edit", 2000);
    local.put("b.md", "local-edit", 2000);
    local.files.delete("c.md");

    const baselineBefore = JSON.stringify(db._get());
    local.ops = [];
    remote.ops = [];
    settings.svrAnchorFixDone = false; // would flip on any real clean run

    const captured = { notifySteps: [] as number[], summary: null as any };
    await runSync("dry", local, remote, db, settings, captured);

    // No mutating call reached either filesystem.
    assert.deepEqual(local.ops, []);
    assert.deepEqual(remote.ops, []);
    // Content is exactly as diverged: nothing pulled, pushed, or deleted.
    assert.equal(remote.read("a.md"), "remote-edit");
    assert.equal(local.read("b.md"), "local-edit");
    assert.deepEqual(remote.fileKeys(), ["a.md", "b.md", "c.md"]);
    assert.deepEqual(local.fileKeys(), ["a.md", "b.md"]);
    // Baseline untouched, migration flags unconsumed.
    assert.equal(JSON.stringify(db._get()), baselineBefore);
    assert.equal(settings.svrAnchorFixDone, false);
    assert.equal(settings.encryptionFixSafetyDone, false);
    // The user was told what would happen.
    assert.ok(captured.summary, "dry run reported a summary");
    assert.equal(captured.summary.totalPlanned, 3);
    assert.equal(captured.summary.byDecision["remote_is_modified_then_pull"], 1);
    assert.equal(captured.summary.byDecision["local_is_modified_then_push"], 1);
    assert.equal(captured.summary.byDecision["local_is_deleted_thus_also_delete_remote"], 1);
    assert.ok(captured.notifySteps.includes(7), "skip notice fired");
    assert.ok(captured.notifySteps.includes(8), "finish notice fired");

    // Positive control: the same divergence executes for real on a manual run,
    // proving this harness would catch a dropped guard.
    await runSync("manual", local, remote, db, settings);
    assert.ok(local.ops.length + remote.ops.length > 0, "manual run executed operations");
    assert.deepEqual(remote.fileKeys(), ["a.md", "b.md"]);
    assert.equal(local.read("a.md"), "remote-edit");
    assert.equal(remote.read("b.md"), "local-edit");
  });

  it("a dry initial sync writes no baseline and reports the plan", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    const settings = makeSettings();
    local.put("first.md", "hello", 1000);

    const captured = { notifySteps: [] as number[], summary: null as any };
    await runSync("dry", local, remote, db, settings, captured);

    assert.deepEqual(remote.fileKeys(), []);
    assert.deepEqual(local.ops, []);
    assert.deepEqual(remote.ops, []);
    assert.equal(db._get(), undefined, "no baseline written by a dry run");
    assert.equal(captured.summary.totalPlanned, 1);
    assert.equal(captured.summary.byDecision["local_is_created_then_push"], 1);
  });

  it("a dry run with nothing to do reports an empty plan", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    const settings = makeSettings();
    local.put("same.md", "stable", 1000);
    await runSync("manual", local, remote, db, settings);

    local.ops = [];
    remote.ops = [];
    const captured = { notifySteps: [] as number[], summary: null as any };
    await runSync("dry", local, remote, db, settings, captured);

    assert.deepEqual(local.ops, []);
    assert.deepEqual(remote.ops, []);
    assert.equal(captured.summary.totalPlanned, 0);
  });
});
