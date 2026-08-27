import { strict as assert } from "assert";
import type { Entity, MixedEntity, SyncDirectionType } from "../src/baseTypes";
import { determineSyncDecision, applySyncDirection } from "../src/sync/planner";
import { FakeFs } from "../src/fsAll";
import { syncer } from "../src/sync/syncer";

function makeEntity(fields: Partial<Entity> & { sizeRaw?: number }): Entity {
  return { keyRaw: "test.md", sizeRaw: 0, ...fields } as Entity;
}

function node(
  local?: Partial<Entity>,
  remote?: Partial<Entity>,
  prevSync?: Partial<Entity>
): MixedEntity {
  return {
    key: "test.md",
    local: local ? makeEntity(local) : undefined,
    remote: remote ? makeEntity(remote) : undefined,
    prevSync: prevSync ? makeEntity(prevSync) : undefined,
  };
}

const T = 100_000; // base timestamp
const D = 10_000; // big delta (clearly changed)

const PUSH_MODES: SyncDirectionType[] = [
  "incremental_push_only",
  "incremental_push_and_delete_only",
];
const PULL_MODES: SyncDirectionType[] = [
  "incremental_pull_only",
  "incremental_pull_and_delete_only",
];

describe("Sync Direction — planner override", () => {
  // Node shapes that produce every planner decision the override can see.
  const shapes: Array<[string, MixedEntity]> = [
    ["remote created", node(undefined, { sizeRaw: 5, mtimeSvr: T })],
    ["local created", node({ sizeRaw: 5, mtimeCli: T })],
    [
      "remote modified",
      node(
        { sizeRaw: 5, mtimeCli: T },
        { sizeRaw: 9, mtimeSvr: T + D },
        { sizeRaw: 5, mtimeCli: T, mtimeSvr: T }
      ),
    ],
    [
      "local modified",
      node(
        { sizeRaw: 9, mtimeCli: T + D },
        { sizeRaw: 5, mtimeSvr: T },
        { sizeRaw: 5, mtimeCli: T, mtimeSvr: T }
      ),
    ],
    [
      "local deleted",
      node(undefined, { sizeRaw: 5, mtimeSvr: T }, { sizeRaw: 5, mtimeSvr: T }),
    ],
    [
      "remote deleted",
      node({ sizeRaw: 5, mtimeCli: T }, undefined, { sizeRaw: 5, mtimeCli: T }),
    ],
    [
      "both changed",
      node(
        { sizeRaw: 9, mtimeCli: T + D },
        { sizeRaw: 7, mtimeSvr: T + D, mtimeCli: T + D },
        { sizeRaw: 5, mtimeCli: T, mtimeSvr: T }
      ),
    ],
  ];

  it("bidirectional (and unknown values) are identity", () => {
    for (const [, n] of shapes) {
      const base = determineSyncDecision(n, "smart_conflict");
      assert.equal(determineSyncDecision(n, "smart_conflict", "bidirectional"), base);
      assert.equal(applySyncDirection(base, "nonsense" as SyncDirectionType), base);
    }
  });

  it("push modes never download and never touch local content", () => {
    for (const direction of PUSH_MODES) {
      for (const [label, n] of shapes) {
        const d = determineSyncDecision(n, "smart_conflict", direction);
        assert.ok(!d.includes("pull"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("delete_local"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("keep_remote"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("smart_conflict"), `${direction} ${label}: ${d}`);
      }
    }
  });

  it("pull modes never upload and never touch remote content", () => {
    for (const direction of PULL_MODES) {
      for (const [label, n] of shapes) {
        const d = determineSyncDecision(n, "smart_conflict", direction);
        assert.ok(!d.includes("push"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("delete_remote"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("keep_local"), `${direction} ${label}: ${d}`);
        assert.ok(!d.includes("smart_conflict"), `${direction} ${label}: ${d}`);
      }
    }
  });

  it("the plain one-way modes never delete anywhere", () => {
    for (const direction of ["incremental_push_only", "incremental_pull_only"] as const) {
      for (const [label, n] of shapes) {
        const d = determineSyncDecision(n, "smart_conflict", direction);
        assert.ok(!d.includes("delete"), `${direction} ${label}: ${d}`);
      }
    }
  });

  it("exhaustive sweep: invariants hold for every mode, shape, and conflict action", () => {
    const allShapes: Array<[string, MixedEntity]> = [
      ...shapes,
      ["no-prev identical", node({ sizeRaw: 5, mtimeCli: T }, { sizeRaw: 5, mtimeCli: T, mtimeSvr: T })],
      ["no-prev different", node({ sizeRaw: 5, mtimeCli: T }, { sizeRaw: 9, mtimeCli: T + D, mtimeSvr: T + D })],
      ["only history", node(undefined, undefined, { sizeRaw: 5, mtimeCli: T })],
      [
        "local deleted, remote changed",
        node(undefined, { sizeRaw: 9, mtimeSvr: T + D }, { sizeRaw: 5, mtimeSvr: T }),
      ],
      [
        "remote deleted, local changed",
        node({ sizeRaw: 9, mtimeCli: T + D }, undefined, { sizeRaw: 5, mtimeCli: T }),
      ],
    ];
    const actions = ["smart_conflict", "keep_newer", "keep_larger"] as const;

    for (const action of actions) {
      for (const [label, n] of allShapes) {
        const base = determineSyncDecision(n, action);
        assert.equal(
          determineSyncDecision(n, action, "bidirectional"),
          base,
          `bidirectional identity: ${action} ${label}`
        );
        for (const direction of PUSH_MODES) {
          const d = determineSyncDecision(n, action, direction);
          for (const banned of ["pull", "delete_local", "keep_remote", "smart_conflict"]) {
            assert.ok(!d.includes(banned), `${direction} ${action} ${label}: ${d}`);
          }
        }
        for (const direction of PULL_MODES) {
          const d = determineSyncDecision(n, action, direction);
          for (const banned of ["push", "delete_remote", "keep_local", "smart_conflict"]) {
            assert.ok(!d.includes(banned), `${direction} ${action} ${label}: ${d}`);
          }
        }
        for (const direction of ["incremental_push_only", "incremental_pull_only"] as const) {
          const d = determineSyncDecision(n, action, direction);
          assert.ok(!d.includes("delete"), `${direction} ${action} ${label}: ${d}`);
        }
      }
    }
  });

  it("push maps the individual decisions per the table", () => {
    const remoteCreated = shapes[0][1];
    const remoteModified = shapes[2][1];
    const localDeleted = shapes[4][1];
    const remoteDeleted = shapes[5][1];
    const bothChanged = shapes[6][1];

    assert.equal(
      determineSyncDecision(remoteCreated, "smart_conflict", "incremental_push_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(remoteModified, "smart_conflict", "incremental_push_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(remoteDeleted, "smart_conflict", "incremental_push_only"),
      "conflict_modified_then_keep_local"
    );
    assert.equal(
      determineSyncDecision(localDeleted, "smart_conflict", "incremental_push_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(localDeleted, "smart_conflict", "incremental_push_and_delete_only"),
      "local_is_deleted_thus_also_delete_remote"
    );
    assert.equal(
      determineSyncDecision(bothChanged, "smart_conflict", "incremental_push_only"),
      "conflict_modified_then_keep_local"
    );
  });

  it("pull maps the individual decisions per the table", () => {
    const localCreated = shapes[1][1];
    const localModified = shapes[3][1];
    const localDeleted = shapes[4][1];
    const remoteDeleted = shapes[5][1];
    const bothChanged = shapes[6][1];

    assert.equal(
      determineSyncDecision(localCreated, "smart_conflict", "incremental_pull_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(localModified, "smart_conflict", "incremental_pull_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(localDeleted, "smart_conflict", "incremental_pull_only"),
      "conflict_modified_then_keep_remote"
    );
    assert.equal(
      determineSyncDecision(remoteDeleted, "smart_conflict", "incremental_pull_only"),
      "conflict_created_then_do_nothing"
    );
    assert.equal(
      determineSyncDecision(remoteDeleted, "smart_conflict", "incremental_pull_and_delete_only"),
      "remote_is_deleted_thus_also_delete_local"
    );
    assert.equal(
      determineSyncDecision(bothChanged, "smart_conflict", "incremental_pull_only"),
      "conflict_modified_then_keep_remote"
    );
  });
});

// ─── End to end: the real syncer honoring the direction ──────────────────────

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

async function runSync(
  local: MemFs,
  remote: MemFs,
  db: any,
  syncDirection?: SyncDirectionType
): Promise<void> {
  const settings: any = {
    password: "",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
    syncDirection,
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

describe("Sync Direction — end to end", () => {
  it("push only: a remote deletion is answered by re-uploading, never deleting locally", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("note.md", "keep me", 1000);
    await runSync(local, remote, db, "incremental_push_only");
    assert.deepEqual(remote.fileKeys(), ["note.md"]);

    remote.files.delete("note.md"); // another device or a remote cleanup
    await runSync(local, remote, db, "incremental_push_only");
    assert.deepEqual(local.fileKeys(), ["note.md"]); // never deleted locally
    assert.equal(remote.read("note.md"), "keep me"); // restored on remote
  });

  it("push only: a local deletion does not propagate, and the plan stays stable", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    await runSync(local, remote, db, "incremental_push_only");

    local.files.delete("a.md");
    await runSync(local, remote, db, "incremental_push_only");
    assert.deepEqual(remote.fileKeys(), ["a.md"]); // remote copy survives

    const writes = remote.writeCount;
    const removals = remote.rmCount;
    await runSync(local, remote, db, "incremental_push_only");
    await runSync(local, remote, db, "incremental_push_only");
    assert.deepEqual(remote.fileKeys(), ["a.md"]); // still there
    assert.deepEqual(local.fileKeys(), []); // never resurrected locally
    assert.equal(remote.writeCount, writes); // no churn
    assert.equal(remote.rmCount, removals);
  });

  it("push and delete: a local deletion does propagate", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    await runSync(local, remote, db, "incremental_push_and_delete_only");

    local.files.delete("a.md");
    await runSync(local, remote, db, "incremental_push_and_delete_only");
    assert.deepEqual(remote.fileKeys(), []);
  });

  it("push only: a remote edit is not downloaded, and a later local edit wins", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("c.md", "base", 1000);
    await runSync(local, remote, db, "incremental_push_only");

    remote.put("c.md", "remote-edit", 50_000);
    await runSync(local, remote, db, "incremental_push_only");
    assert.equal(local.read("c.md"), "base"); // nothing pulled
    assert.equal(remote.read("c.md"), "remote-edit"); // remote left alone

    local.put("c.md", "local-edit", 90_000);
    await runSync(local, remote, db, "incremental_push_only");
    assert.equal(remote.read("c.md"), "local-edit"); // local is the source of truth
    assert.deepEqual(local.fileKeys(), ["c.md"]); // no conflict copies appear
  });

  it("pull only: a local deletion is answered by re-downloading, never deleting remotely", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    remote.put("note.md", "server copy", 1000);
    await runSync(local, remote, db, "incremental_pull_only");
    assert.equal(local.read("note.md"), "server copy");

    local.files.delete("note.md");
    await runSync(local, remote, db, "incremental_pull_only");
    assert.deepEqual(remote.fileKeys(), ["note.md"]); // remote untouched
    assert.equal(local.read("note.md"), "server copy"); // restored locally
  });

  it("bidirectional behavior is unchanged when the setting is absent", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "x", 1000);
    await runSync(local, remote, db); // no direction passed
    local.files.delete("a.md");
    await runSync(local, remote, db);
    assert.deepEqual(remote.fileKeys(), []); // deletes still propagate by default
  });
});
