import { strict as assert } from "assert";
import { FakeFs } from "../src/fsAll";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { syncer } from "../src/sync/syncer";

// End-to-end encrypted sync over an in-memory backend, no cloud account needed.
// The "remote" MemFs plays the role of the raw provider (e.g. pCloud): it stores
// whatever the encryption layer writes (ciphertext names + content). The syncer
// runs against a FakeFsEncrypt wrapping it, exactly as production does.
class MemFs extends FakeFs {
  kind: string;
  files = new Map<string, { content: ArrayBuffer; mtime: number; ctime: number; folder: boolean }>();
  writeCount = 0;
  rmCount = 0;
  constructor(kind: string) {
    super();
    this.kind = kind;
  }
  async walk(): Promise<any[]> {
    return [...this.files].map(([key, f]) =>
      f.folder
        ? { key, keyRaw: key, size: 0, sizeRaw: 0 }
        : { key, keyRaw: key, mtimeCli: f.mtime, mtimeSvr: f.mtime, size: f.content.byteLength, sizeRaw: f.content.byteLength }
    );
  }
  async walkPartial(): Promise<any[]> {
    return this.walk();
  }
  async stat(key: string): Promise<any> {
    const f = this.files.get(key);
    if (!f) throw new Error(`status 404 not found: ${key}`);
    const b = { key, keyRaw: key, mtimeCli: f.mtime, mtimeSvr: f.mtime, ctimeCli: f.ctime };
    return f.folder ? { ...b, size: 0, sizeRaw: 0 } : { ...b, size: f.content.byteLength, sizeRaw: f.content.byteLength };
  }
  async mkdir(key: string, mtime = 1, ctime = 1): Promise<any> {
    this.files.set(key, { content: new ArrayBuffer(0), mtime, ctime, folder: true });
    return { key, keyRaw: key, size: 0, sizeRaw: 0, mtimeCli: mtime, mtimeSvr: mtime };
  }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number): Promise<any> {
    this.writeCount++;
    this.files.set(key, { content, mtime, ctime, folder: false });
    return { key, keyRaw: key, mtimeCli: mtime, mtimeSvr: mtime, ctimeCli: ctime, size: content.byteLength, sizeRaw: content.byteLength };
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
    this.files.set(key, { content: u.buffer.slice(0, u.byteLength), mtime, ctime: mtime, folder: false });
  }
  read(key: string): string {
    const f = this.files.get(key);
    return f ? new TextDecoder().decode(f.content) : "";
  }
  fileKeys(): string[] {
    return [...this.files.keys()].filter((k) => !k.endsWith("/")).sort();
  }
  ciphertextCount(): number {
    return [...this.files.keys()].filter((k) => !k.endsWith("/")).length;
  }
}

function makeDb() {
  let store: any[] | undefined;
  return {
    prevSyncRecordsTbl: {
      async getItem() {
        return store;
      },
      async setItem(_id: string, v: any[]) {
        store = v;
      },
    },
  } as any;
}

// Returns the messages passed to errNotifyFunc (warnings + aborts). The real
// syncer never rejects; it routes all failures through errNotifyFunc, so tests
// assert on the collected messages plus the resulting file state.
function defaultEncSettings(password: string): any {
  return {
    password,
    encryptionMethod: "openssl-base64",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
    // Default the one-time upgrade net to "already satisfied" so core-behavior
    // tests exercise steady state. The migration test passes its own settings.
    encryptionFixSafetyDone: true,
  };
}

async function runSyncEnc(
  local: MemFs,
  remoteInner: MemFs,
  db: any,
  password: string,
  settings?: any
): Promise<string[]> {
  const fsEncrypt = new FakeFsEncrypt(remoteInner as any, password, "openssl-base64");
  settings = settings ?? defaultEncSettings(password);
  const notifications: string[] = [];
  await syncer(
    local as any,
    remoteInner as any,
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
    () => "",
    async () => {},
    async () => {},
    async (_s: any, e: Error) => {
      notifications.push(e.message);
    },
    async () => {},
    async () => {},
    async () => {}
  );
  return notifications;
}

describe("Encrypted sync end-to-end (openssl-base64)", () => {
  before(function () {
    (global as any).window = { crypto: require("crypto").webcrypto };
    (global as any).activeWindow = (global as any).window;
  });

  it("pushes an encrypted file and is stable on re-sync (no delete, no re-upload)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("plain.md", "hello", 1000);

    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["plain.md"], "local intact after first sync");
    assert.equal(remote.ciphertextCount(), 1, "one encrypted file on remote");
    const writesAfterFirst = remote.writeCount;

    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["plain.md"], "local file survives re-sync (no wrongful delete)");
    assert.equal(local.rmCount, 0, "no local deletions across re-sync");
    assert.equal(remote.writeCount - writesAfterFirst, 0, "no redundant re-upload");
  });

  it("propagates a local modify without spawning a conflict copy", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("note.md", "v1", 1000);
    await runSyncEnc(local, remote, db, "hunter2");

    local.put("note.md", "v2 longer content", 2000);
    await runSyncEnc(local, remote, db, "hunter2");

    assert.deepEqual(local.fileKeys(), ["note.md"], "no conflict copy created for a plain local edit");
    // remote should now hold the updated ciphertext; pulling it back decrypts to v2
    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["note.md"], "still stable, no conflict churn");
    assert.equal(local.read("note.md"), "v2 longer content");
  });

  it("modify after an idle re-sync still pushes cleanly (baseline anchors preserved)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("doc.md", "v1", 1000);
    await runSyncEnc(local, remote, db, "hunter2"); // push
    await runSyncEnc(local, remote, db, "hunter2"); // idle re-sync (commits an 'equal' baseline)

    local.put("doc.md", "v2 changed", 2000); // now edit
    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["doc.md"], "edit after idle re-sync must not spawn a conflict copy");
  });

  it("moves an encrypted file without duplicating or losing it", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a/note.md", "body", 1000);
    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["a/note.md"]);
    assert.equal(remote.ciphertextCount(), 1);

    // Move a/note.md -> b/note.md locally. supportsRename() is false for the
    // remote (as pCloud now is), so this exercises the delete + create path.
    local.files.delete("a/note.md");
    local.put("b/note.md", "body", 1000);
    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["b/note.md"], "move applied locally");
    assert.equal(remote.ciphertextCount(), 1, "exactly one encrypted file on remote (no duplicate)");

    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["b/note.md"], "stable; old path does not reappear");
    assert.equal(local.read("b/note.md"), "body");
  });

  it("propagates a local delete and does not resurrect it", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("gone.md", "bye", 1000);
    await runSyncEnc(local, remote, db, "hunter2");

    local.files.delete("gone.md");
    await runSyncEnc(local, remote, db, "hunter2");
    assert.equal(remote.ciphertextCount(), 0, "delete propagated to remote");

    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), [], "does not resurrect locally");
    assert.equal(remote.ciphertextCount(), 0);
  });

  it("pulls a file created on another device (remote-first)", async () => {
    const localA = new MemFs("localA");
    const remote = new MemFs("remote");
    const dbA = makeDb();
    localA.put("shared.md", "from A", 1000);
    await runSyncEnc(localA, remote, dbA, "hunter2"); // A uploads

    const localB = new MemFs("localB"); // fresh device, same remote + password
    const dbB = makeDb();
    await runSyncEnc(localB, remote, dbB, "hunter2");
    assert.deepEqual(localB.fileKeys(), ["shared.md"], "device B pulls the encrypted file");
    assert.equal(localB.read("shared.md"), "from A");
  });

  it("round-trips a non-ASCII filename containing a format character (ZWNJ)", async () => {
    // ZWNJ (U+200C) is a legitimate, common character in Persian/Arabic/Hindi
    // filenames. It must survive encrypt -> store -> decrypt -> match, not be
    // dropped as 'undecryptable' and cause the local file to be deleted.
    const name = "note‌book.md";
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put(name, "content", 1000);

    await runSyncEnc(local, remote, db, "hunter2");
    assert.equal(remote.ciphertextCount(), 1);

    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), [name], "ZWNJ-named file survives re-sync");
    assert.equal(local.rmCount, 0, "ZWNJ-named file is not wrongly deleted");
  });

  it("keeps a local deletion deleted across repeated syncs (no resurrection, #4/#985/#991)", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("note.md", "content", 1000);
    await runSyncEnc(local, remote, db, "hunter2"); // synced on both sides

    local.files.delete("note.md"); // user deletes locally
    await runSyncEnc(local, remote, db, "hunter2");
    assert.equal(remote.ciphertextCount(), 0, "deletion propagated to remote");

    // The #4 symptom was "any delete I make always comes back" under bidirectional
    // sync. Repeated syncs must never resurrect it on either side.
    for (let i = 0; i < 3; i++) await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), [], "stays deleted locally");
    assert.equal(remote.ciphertextCount(), 0, "stays deleted remotely");
  });

  it("removes a remotely deleted file locally without resurrection", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("shared.md", "x", 1000);
    await runSyncEnc(local, remote, db, "hunter2");

    remote.files.clear(); // another device deleted it
    await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), [], "removed locally");

    for (let i = 0; i < 3; i++) await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), [], "stays removed, no resurrection");
  });

  it("round-trips content and deletes with a unicode/special-character password", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    const pw = "pä$$wörd 🔐 سر";
    local.put("secret.md", "top secret", 1000);
    await runSyncEnc(local, remote, db, pw);
    await runSyncEnc(local, remote, db, pw); // stable
    assert.deepEqual(local.fileKeys(), ["secret.md"], "survives re-sync");
    assert.equal(local.rmCount, 0, "no wrongful delete");

    // A fresh device with the same password pulls and decrypts correctly.
    const localB = new MemFs("localB");
    const dbB = makeDb();
    await runSyncEnc(localB, remote, dbB, pw);
    assert.equal(localB.read("secret.md"), "top secret", "decrypts on another device");

    // And a delete still propagates and stays deleted under this password.
    local.files.delete("secret.md");
    await runSyncEnc(local, remote, db, pw);
    await runSyncEnc(local, remote, db, pw);
    assert.deepEqual(local.fileKeys(), [], "delete sticks under a special-char password");
  });

  it("keeps local files (and warns) when some remote entries cannot be decrypted", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("a.md", "aa", 1000);
    local.put("b.md", "bb", 1000);
    await runSyncEnc(local, remote, db, "hunter2");
    assert.equal(remote.ciphertextCount(), 2);

    // Corrupt exactly one stored entry so its name no longer decrypts (partial).
    const victim = [...remote.files.keys()][0];
    const f = remote.files.get(victim)!;
    remote.files.delete(victim);
    remote.files.set("U2FsdGVkX1corruptedgarbagevalue", f);

    const notes = await runSyncEnc(local, remote, db, "hunter2");
    assert.equal(local.rmCount, 0, "no local deletions while decryption is failing");
    assert.deepEqual(local.fileKeys(), ["a.md", "b.md"], "both local files kept");
    assert.ok(
      notes.some((n) => /could not be decrypted/i.test(n)),
      "user is warned about the undecryptable entry"
    );
  });

  it("aborts without touching local files when nothing on the remote decrypts", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("only.md", "x", 1000);
    await runSyncEnc(local, remote, db, "hunter2");

    // Corrupt the only entry: nothing decrypts (wholesale wrong password/method).
    const victim = [...remote.files.keys()][0];
    const f = remote.files.get(victim)!;
    remote.files.delete(victim);
    remote.files.set("U2FsdGVkX1corruptedgarbagevalue", f);

    const notes = await runSyncEnc(local, remote, db, "hunter2");
    assert.deepEqual(local.fileKeys(), ["only.md"], "local untouched on abort");
    assert.equal(local.rmCount, 0);
    assert.ok(
      notes.some((n) => /aborted/i.test(n)),
      "sync aborts with a clear message"
    );
  });

  it("holds a remote-driven local delete on the first post-upgrade sync, applies it on the next", async () => {
    const local = new MemFs("local");
    const remote = new MemFs("remote");
    const db = makeDb();
    local.put("x.md", "data", 1000);
    await runSyncEnc(local, remote, db, "hunter2"); // setup: baseline + remote + local hold x.md

    // Another device deletes x.md on the remote.
    remote.files.clear();

    // First sync after upgrade: safety net not yet satisfied.
    const settings = defaultEncSettings("hunter2");
    settings.encryptionFixSafetyDone = false;

    const notes1 = await runSyncEnc(local, remote, db, "hunter2", settings);
    assert.deepEqual(local.fileKeys(), ["x.md"], "local file is held, not deleted, on first sync");
    assert.ok(
      notes1.some((n) => /safety check/i.test(n)),
      "user is told about the one-time safety hold"
    );
    assert.equal(settings.encryptionFixSafetyDone, true, "safety net marked satisfied after the run");

    // Next sync: the intended remote deletion now propagates.
    await runSyncEnc(local, remote, db, "hunter2", settings);
    assert.deepEqual(local.fileKeys(), [], "deletion applies on the subsequent sync");
  });
});

describe("Encrypted fresh device onto a populated remote (#11)", () => {
  before(function () {
    (global as any).window = { crypto: require("crypto").webcrypto };
    (global as any).activeWindow = (global as any).window;
  });

  it("adopts the matching state through the real encryption layer without transferring", async () => {
    const deviceA = new MemFs("local");
    const remote = new MemFs("remote");
    const dbA = makeDb();
    deviceA.put("a.md", "alpha", 1000);
    deviceA.put("b.md", "bravo bravo", 2000);
    await runSyncEnc(deviceA, remote, dbA, "hunter2"); // uploads ciphertext

    // Second device: identical vault contents and mtimes, no local baseline.
    const deviceB = new MemFs("local");
    deviceB.put("a.md", "alpha", 1000);
    deviceB.put("b.md", "bravo bravo", 2000);
    const dbB = makeDb();
    const remoteWritesBefore = remote.writeCount;

    const notices = await runSyncEnc(deviceB, remote, dbB, "hunter2");

    assert.equal(deviceB.writeCount, 0, "nothing downloaded onto the new device");
    assert.equal(remote.writeCount, remoteWritesBefore, "nothing re-uploaded");
    assert.equal(deviceB.rmCount + remote.rmCount, 0, "nothing deleted");
    assert.deepEqual(deviceB.fileKeys(), ["a.md", "b.md"], "no conflict copies");
    assert.deepEqual(notices, [], "no protection abort");

    // And the adopted baseline is complete: the next sync is also a no-op.
    await runSyncEnc(deviceB, remote, dbB, "hunter2");
    assert.equal(deviceB.writeCount, 0);
    assert.equal(remote.writeCount, remoteWritesBefore);
  });

  it("a file whose mtime genuinely differs still resolves as a conflict", async () => {
    const deviceA = new MemFs("local");
    const remote = new MemFs("remote");
    await runSyncEnc(deviceA, remote, makeDb(), "hunter2");
    deviceA.put("d.md", "device A version", 1000);
    await runSyncEnc(deviceA, remote, makeDb(), "hunter2");

    const deviceB = new MemFs("local");
    deviceB.put("d.md", "device B version", 5_000_000);
    await runSyncEnc(deviceB, remote, makeDb(), "hunter2");

    const extras = deviceB.fileKeys().filter((k) => k !== "d.md");
    assert.equal(extras.length, 1, "one conflict copy for the genuinely divergent file");
  });
});
