import { strict as assert } from "assert";
import type { Entity, MixedEntity } from "../src/baseTypes";
import { determineSyncDecision } from "../src/sync/planner";

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
const D = 10_000;  // big delta (clearly changed)
const S = 500;     // small delta (within 2s tolerance — should NOT count as changed)

describe("Sync Planner — 3-Way Merge Decision Matrix", () => {

  // ── Additions ───────────────────────────────────────────────────────────
  it("local created → push", () => {
    assert.equal(
      determineSyncDecision(node({ mtimeCli: T }), "smart_conflict"),
      "local_is_created_then_push"
    );
  });

  it("remote created → pull", () => {
    assert.equal(
      determineSyncDecision(node(undefined, { mtimeSvr: T }), "smart_conflict"),
      "remote_is_created_then_pull"
    );
  });

  // ── Equal (no change) ────────────────────────────────────────────────────
  it("both equal to prevSync → equal", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T }, { sizeRaw: 10, mtimeSvr: T }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "equal"
    );
  });

  it("timestamps within tolerance → equal (no spurious conflict)", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + S }, { sizeRaw: 10, mtimeSvr: T }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "equal"
    );
  });

  it("mtime changed but size identical → still detects change (same-size edit)", () => {
    // Validates that toggling a checkbox (same byte count) triggers sync
    assert.equal(
      determineSyncDecision(
        node(
          { sizeRaw: 10, mtimeCli: T + D },
          { sizeRaw: 10, mtimeSvr: T },
          { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }
        ),
        "smart_conflict"
      ),
      "local_is_modified_then_push"
    );
  });

  it("remote mtime changed but size identical → detects change", () => {
    assert.equal(
      determineSyncDecision(
        node(
          { sizeRaw: 10, mtimeCli: T },
          { sizeRaw: 10, mtimeSvr: T + D },
          { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }
        ),
        "smart_conflict"
      ),
      "remote_is_modified_then_pull"
    );
  });

  // ── Modifications ────────────────────────────────────────────────────────
  it("local modified, remote unchanged → push", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 20, mtimeCli: T + D }, { sizeRaw: 10, mtimeSvr: T }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "local_is_modified_then_push"
    );
  });

  it("remote modified, local unchanged → pull", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T }, { sizeRaw: 20, mtimeSvr: T + D }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "remote_is_modified_then_pull"
    );
  });

  // ── Deletions ────────────────────────────────────────────────────────────
  it("local deleted, remote unchanged → delete remote", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 10, mtimeSvr: T }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "local_is_deleted_thus_also_delete_remote"
    );
  });

  it("remote deleted, local unchanged → delete local", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "remote_is_deleted_thus_also_delete_local"
    );
  });

  it("both missing with prevSync → only_history", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "only_history"
    );
  });

  // ── Delete-vs-Modify conflicts (new edge cases) ──────────────────────────
  it("local deleted BUT remote was modified → smart_conflict (not blind delete)", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 20, mtimeSvr: T + D }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("remote deleted BUT local was modified → smart_conflict (not blind delete)", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 20, mtimeCli: T + D }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  // ── True conflicts ───────────────────────────────────────────────────────
  it("both modified → smart_conflict", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 20, mtimeCli: T + D }, { sizeRaw: 30, mtimeSvr: T + D }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("created on both sides → smart_conflict", () => {
    assert.equal(
      determineSyncDecision(node({ sizeRaw: 10, mtimeCli: T }, { sizeRaw: 20, mtimeSvr: T + D }), "smart_conflict"),
      "conflict_created_then_smart_conflict"
    );
  });

  // ── keep_newer ───────────────────────────────────────────────────────────
  it("keep_newer: local is newer → keep_local", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + D }, { sizeRaw: 20, mtimeSvr: T }, { sizeRaw: 5, mtimeCli: T - D, mtimeSvr: T - D }),
        "keep_newer"
      ),
      "conflict_modified_then_keep_local"
    );
  });

  it("keep_newer: remote is newer → keep_remote", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T }, { sizeRaw: 20, mtimeSvr: T + D }, { sizeRaw: 5, mtimeCli: T - D, mtimeSvr: T - D }),
        "keep_newer"
      ),
      "conflict_modified_then_keep_remote"
    );
  });

  // ── keep_larger ──────────────────────────────────────────────────────────
  it("keep_larger: local is larger → keep_local", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 500, mtimeCli: T + D }, { sizeRaw: 20, mtimeSvr: T + D }, { sizeRaw: 5, mtimeCli: T - D, mtimeSvr: T - D }),
        "keep_larger"
      ),
      "conflict_modified_then_keep_local"
    );
  });

  it("keep_larger: remote is larger → keep_remote", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + D }, { sizeRaw: 500, mtimeSvr: T + D }, { sizeRaw: 5, mtimeCli: T - D, mtimeSvr: T - D }),
        "keep_larger"
      ),
      "conflict_modified_then_keep_remote"
    );
  });

  // ── Deletion with mtime drift (#985, #991) ─────────────────────────────
  const SMALL_DRIFT = 5_000;    // 5s — within 30s relaxed tolerance
  const LARGE_DRIFT = 60_000;   // 60s — exceeds relaxed tolerance

  it("remote deleted, local mtime drifted within tolerance → delete local (not conflict)", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + SMALL_DRIFT }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "remote_is_deleted_thus_also_delete_local"
    );
  });

  it("remote deleted, local mtime drifted beyond tolerance → conflict", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + LARGE_DRIFT }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("remote deleted, local size changed → conflict", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 20, mtimeCli: T }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("local deleted, remote mtime drifted within tolerance → delete remote (not conflict)", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 10, mtimeSvr: T + SMALL_DRIFT }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "local_is_deleted_thus_also_delete_remote"
    );
  });

  it("local deleted, remote mtime drifted beyond tolerance → conflict", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 10, mtimeSvr: T + LARGE_DRIFT }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("local deleted, remote size changed → conflict", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 20, mtimeSvr: T }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "conflict_modified_then_smart_conflict"
    );
  });

  it("remote deleted, local truly unchanged → delete local", () => {
    assert.equal(
      determineSyncDecision(
        node({ sizeRaw: 10, mtimeCli: T + S }, undefined, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "remote_is_deleted_thus_also_delete_local"
    );
  });

  it("local deleted, remote truly unchanged → delete remote", () => {
    assert.equal(
      determineSyncDecision(
        node(undefined, { sizeRaw: 10, mtimeSvr: T + S, mtimeCli: T + S }, { sizeRaw: 10, mtimeCli: T, mtimeSvr: T }),
        "smart_conflict"
      ),
      "local_is_deleted_thus_also_delete_remote"
    );
  });
});

