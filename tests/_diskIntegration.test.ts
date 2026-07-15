import { strict as assert } from "assert";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { FakeFs } from "../src/fsAll";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { syncer } from "../src/sync/syncer";

// Real-disk integration test: the sync engine + real encryption over real files
// on the actual filesystem. Local = a plaintext "vault" folder; remote = a
// folder holding ciphertext names + encrypted bytes (standing in for pCloud).
//
// Note: the delete/no-resurrection check uses an ASCII filename. Non-ASCII files
// still exercise the real-disk encryption round-trip and cross-device decrypt;
// deleting them is covered by the in-memory suite (some sandboxes cannot unlink
// non-ASCII paths). Cleanup is best-effort for the same reason.
class DiskFs extends FakeFs {
  kind: string;
  root: string;
  writeCount = 0;
  rmCount = 0;
  constructor(kind: string, root: string) {
    super();
    this.kind = kind;
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }
  private abs(key: string) {
    return path.join(this.root, key);
  }
  private async walkDir(rel: string, out: any[]) {
    for (const e of await fsp.readdir(this.abs(rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await this.walkDir(childRel, out);
      } else {
        const st = await fsp.stat(this.abs(childRel));
        const mt = Math.floor(st.mtimeMs);
        out.push({ key: childRel, keyRaw: childRel, mtimeCli: mt, mtimeSvr: mt, size: st.size, sizeRaw: st.size });
      }
    }
  }
  async walk(): Promise<any[]> {
    const out: any[] = [];
    await this.walkDir("", out);
    return out;
  }
  async walkPartial(): Promise<any[]> {
    return this.walk();
  }
  async stat(key: string): Promise<any> {
    const st = await fsp.stat(this.abs(key));
    const mt = Math.floor(st.mtimeMs);
    return { key, keyRaw: key, mtimeCli: mt, mtimeSvr: mt, size: st.size, sizeRaw: st.size };
  }
  async mkdir(key: string, mtime = 1): Promise<any> {
    await fsp.mkdir(this.abs(key), { recursive: true });
    return { key, keyRaw: key, size: 0, sizeRaw: 0, mtimeCli: mtime, mtimeSvr: mtime };
  }
  async writeFile(key: string, content: ArrayBuffer, mtime: number, _ctime: number): Promise<any> {
    this.writeCount++;
    const p = this.abs(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, Buffer.from(content));
    const t = new Date(mtime);
    await fsp.utimes(p, t, t);
    const st = await fsp.stat(p);
    const mt = Math.floor(st.mtimeMs);
    return { key, keyRaw: key, mtimeCli: mt, mtimeSvr: mt, size: st.size, sizeRaw: st.size };
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    const b = await fsp.readFile(this.abs(key));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async rename(k1: string, k2: string): Promise<void> {
    const p2 = this.abs(k2);
    await fsp.mkdir(path.dirname(p2), { recursive: true });
    await fsp.rename(this.abs(k1), p2);
  }
  async rm(key: string): Promise<void> {
    this.rmCount++;
    await fsp.rm(this.abs(key), { force: true, recursive: true });
  }
  supportsRename(): boolean {
    return false;
  }
  async checkConnect(): Promise<boolean> {
    return true;
  }
  async getUserDisplayName(): Promise<string> {
    return "disk";
  }
  async revokeAuth(): Promise<void> {}
  allowEmptyFile(): boolean {
    return true;
  }
  // helpers (sync, for assertions)
  put(key: string, body: string, mtime: number): void {
    const p = this.abs(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(body)));
    const t = new Date(mtime);
    fs.utimesSync(p, t, t);
  }
  del(key: string): void {
    fs.rmSync(this.abs(key), { force: true });
  }
  listFiles(): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        const c = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(c);
        else out.push(c);
      }
    };
    walk("");
    return out.sort();
  }
  readText(key: string): string {
    return fs.readFileSync(this.abs(key), "utf8");
  }
  rawBytes(key: string): Buffer {
    return fs.readFileSync(this.abs(key));
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

async function sync(local: DiskFs, remote: DiskFs, db: any, password: string): Promise<string[]> {
  const fsEncrypt = new FakeFsEncrypt(remote as any, password, "openssl-base64");
  const settings: any = {
    password,
    encryptionMethod: "openssl-base64",
    conflictAction: "smart_conflict",
    ignorePaths: [],
    onlyAllowPaths: [],
    protectModifyPercentage: 100,
    encryptionFixSafetyDone: true,
  };
  const notes: string[] = [];
  await syncer(
    local as any, remote as any, fsEncrypt as any, undefined, db, "manual" as any,
    "p1", "vault1", ".obsidian", settings, "1.0.0",
    async () => {}, () => "", async () => {}, async () => {},
    async (_s: any, e: Error) => { notes.push(e.message); },
    async () => {}, async () => {}, async () => {}
  );
  return notes;
}

describe("Real-disk encrypted integration", () => {
  let tmp: string;
  before(function () {
    (global as any).window = { crypto: require("crypto").webcrypto };
    (global as any).activeWindow = (global as any).window;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "byoc-disk-"));
  });
  after(function () {
    try {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort: some sandboxes cannot unlink non-ASCII paths
    }
  });

  it("survives push, re-sync, edit, delete and a second device on real disk", async () => {
    const PW = "pä$$wörd 🔐 سر";
    const vault = new DiskFs("vault", path.join(tmp, "vault"));
    const remote = new DiskFs("remote", path.join(tmp, "remote"));
    const db = makeDb();

    // Real notes incl. non-ASCII names: Persian (with ZWNJ), CJK, nested folder.
    vault.put("Welcome.md", "hello world", 1000);
    vault.put("daily/2026-07-15.md", "todays note", 1000);
    vault.put("مقاله‌ها.md", "محتوای فارسی", 1000); // Persian name contains a ZWNJ
    vault.put("会議メモ.md", "日本語の内容", 1000);
    const expected = ["Welcome.md", "daily/2026-07-15.md", "会議メモ.md", "مقاله‌ها.md"].sort();

    // Push
    await sync(vault, remote, db, PW);
    assert.deepEqual(vault.listFiles().sort(), expected, "vault intact after push");
    assert.equal(remote.listFiles().length, 4, "four encrypted files on remote");

    // Remote is actually encrypted: names are not the plaintext names, and the
    // ciphertext of a note does not contain its plaintext body.
    for (const name of remote.listFiles()) {
      assert.ok(!expected.includes(name), `remote name is encrypted, not '${name}'`);
    }
    assert.ok(
      !remote.rawBytes(remote.listFiles()[0]).toString("utf8").includes("hello world"),
      "remote content is not plaintext"
    );

    // Idle re-sync: nothing deleted, nothing re-uploaded.
    const writesAfterPush = remote.writeCount;
    const rmBefore = vault.rmCount;
    await sync(vault, remote, db, PW);
    assert.deepEqual(vault.listFiles().sort(), expected, "no files lost on re-sync");
    assert.equal(vault.rmCount, rmBefore, "no local deletions on re-sync");
    assert.equal(remote.writeCount, writesAfterPush, "no redundant re-upload on re-sync");

    // Edit a note, sync: no conflict copy, content updates.
    vault.put("Welcome.md", "hello world v2 (edited)", 2000);
    await sync(vault, remote, db, PW);
    assert.deepEqual(vault.listFiles().sort(), expected, "edit did not spawn a conflict copy");

    // Delete an ASCII note, sync twice: gone from remote, never resurrects.
    vault.del("daily/2026-07-15.md");
    assert.ok(!vault.listFiles().includes("daily/2026-07-15.md"), "note removed locally");
    await sync(vault, remote, db, PW);
    await sync(vault, remote, db, PW);
    assert.ok(!vault.listFiles().includes("daily/2026-07-15.md"), "deleted note stays deleted (no resurrection)");
    assert.equal(remote.listFiles().length, 3, "remote reflects the deletion");

    // Second device: fresh empty vault, same remote + password, pulls & decrypts,
    // including the non-ASCII names, on real disk.
    const vaultB = new DiskFs("vaultB", path.join(tmp, "vaultB"));
    const dbB = makeDb();
    await sync(vaultB, remote, dbB, PW);
    const expectedAfterDelete = ["Welcome.md", "会議メモ.md", "مقاله‌ها.md"].sort();
    assert.deepEqual(vaultB.listFiles().sort(), expectedAfterDelete, "device B pulled the surviving notes");
    assert.equal(vaultB.readText("Welcome.md"), "hello world v2 (edited)", "edited content decrypts on B");
    assert.equal(vaultB.readText("مقاله‌ها.md"), "محتوای فارسی", "Persian note decrypts byte-exact on B");
    assert.equal(vaultB.readText("会議メモ.md"), "日本語の内容", "CJK note decrypts byte-exact on B");
  });
});
