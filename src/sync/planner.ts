import type { Entity, MixedEntity, ConflictActionType, DecisionTypeForMixedEntity, SyncDirectionType } from "../baseTypes";

// Two timestamps are considered equal if within 2 seconds of each other.
// Necessary because providers and local FS have different mtime precision.
const MTIME_TOLERANCE_MS = 2000;

const mtimeChanged = (current?: number, baseline?: number): boolean => {
  if (current === undefined || baseline === undefined) return false;
  return Math.abs(current - baseline) > MTIME_TOLERANCE_MS;
};

// For deletion branches, use a relaxed tolerance to absorb cross-platform
// mtime drift (FAT32, cloud normalization, Obsidian metadata touches).
const DELETION_MTIME_TOLERANCE_MS = 30_000; // 30 seconds

const mtimeChangedRelaxed = (current?: number, baseline?: number): boolean => {
  if (current === undefined || baseline === undefined) return false;
  return Math.abs(current - baseline) > DELETION_MTIME_TOLERANCE_MS;
};

const newerSide = (
  local?: number,
  remote?: number
): "local" | "remote" | "equal" => {
  if (local === undefined && remote === undefined) return "equal";
  if (local === undefined) return "remote";
  if (remote === undefined) return "local";
  if (Math.abs(local - remote) <= MTIME_TOLERANCE_MS) return "equal";
  return local > remote ? "local" : "remote";
};

const largerSide = (
  localSize?: number,
  remoteSize?: number
): "local" | "remote" | "equal" => {
  if (localSize === undefined && remoteSize === undefined) return "equal";
  if (localSize === undefined) return "remote";
  if (remoteSize === undefined) return "local";
  if (localSize === remoteSize) return "equal";
  return localSize > remoteSize ? "local" : "remote";
};

/**
 * determineSyncDecision computes the 3-way merge result for a single entity.
 *
 * State matrix:
 *   local | remote | prevSync → decision
 *   ──────┼────────┼──────────────────────────────
 *   ✗     | ✗      | any     → only_history (already gone both sides)
 *   ✗     | ✓      | ✗       → remote_is_created_then_pull
 *   ✓     | ✗      | ✗       → local_is_created_then_push
 *   ✓     | ✓      | ✗       → conflict_created (both added independently)
 *   ✗     | ✓      | ✓       → check remote vs prevSync:
 *                               remote unchanged → local deleted → delete remote
 *                               remote changed   → conflict (delete vs modify)
 *   ✓     | ✗      | ✓       → check local vs prevSync:
 *                               local unchanged  → remote deleted → delete local
 *                               local changed    → conflict (modify vs delete)
 *   ✓     | ✓      | ✓       → compare each side to baseline → push/pull/conflict/equal
 */
export const determineSyncDecision = (
  node: MixedEntity,
  conflictAction: ConflictActionType,
  syncDirection: SyncDirectionType = "bidirectional"
): DecisionTypeForMixedEntity => {
  return applySyncDirection(
    determineBidirectionalDecision(node, conflictAction),
    syncDirection
  );
};

const determineBidirectionalDecision = (
  node: MixedEntity,
  conflictAction: ConflictActionType
): DecisionTypeForMixedEntity => {
  const { local, remote, prevSync } = node;

  const hasLocal = local !== undefined;
  const hasRemote = remote !== undefined;
  const hasPrev = prevSync !== undefined;

  // ── Both missing ─────────────────────────────────────────────────────────
  if (!hasLocal && !hasRemote) {
    return "only_history";
  }

  // ── One side present, no history ─────────────────────────────────────────
  if (hasLocal && !hasRemote && !hasPrev) {
    return "local_is_created_then_push";
  }

  if (!hasLocal && hasRemote && !hasPrev) {
    return "remote_is_created_then_pull";
  }

  // ── Both present, no history → created independently on both sides ───────
  if (hasLocal && hasRemote && !hasPrev) {
    return resolveCreatedConflict(conflictAction, local, remote);
  }

  // ── Local missing, prev exists → local was deleted ───────────────────────
  if (!hasLocal && hasRemote && hasPrev) {
    // Use relaxed mtime tolerance for deletion branches to prevent
    // mtime drift from overriding confirmed deletions (#985, #991).
    //
    // For an encrypted remote, remote.sizeRaw holds the ciphertext byte size
    // (the plaintext size is unknowable without downloading), while the baseline
    // prevSync.sizeRaw is anchored to the plaintext size. Comparing those two
    // directly always reports "changed" for any encrypted file, which misreads a
    // genuine deletion as a delete-vs-modify conflict and resurrects the file
    // (the webdav + password case of #985, #991). Compare against the baseline
    // ciphertext size instead, mirroring the both-present branch below.
    const remoteBaselineSize =
      remote.sizeEnc !== undefined
        ? (prevSync.sizeEnc ?? prevSync.sizeRaw)
        : prevSync.sizeRaw;
    const remoteContentChanged =
      remote.sizeRaw !== remoteBaselineSize ||
      mtimeChangedRelaxed(remote.mtimeSvr, prevSync.mtimeSvr) ||
      mtimeChangedRelaxed(remote.mtimeCli, prevSync.mtimeCli);

    if (remoteContentChanged) {
      // Remote was modified after our last sync — treat as conflict.
      // The local copy is gone, so there is nothing to preserve in a conflict
      // copy; smart_conflict would read a file that no longer exists, throw, and
      // leave the sync permanently in an error state. Keep the other device's
      // version instead.
      return "conflict_modified_then_keep_remote";
    }
    return "local_is_deleted_thus_also_delete_remote";
  }

  // ── Remote missing, prev exists → remote was deleted ─────────────────────
  if (hasLocal && !hasRemote && hasPrev) {
    // A folder that the remote only ever synthesized (S3 with the default
    // generateFolderObject off keeps it in an in-memory cache that an app
    // restart clears) cannot exist remotely at all, so its absence is not
    // evidence of a deletion. A folder the remote genuinely materialised still
    // deletes normally.
    if (node.key.endsWith("/") && prevSync.synthesizedFolder === true) {
      return "equal";
    }

    const localContentChanged =
      local.sizeRaw !== prevSync.sizeRaw ||
      mtimeChangedRelaxed(local.mtimeCli, prevSync.mtimeCli);

    if (localContentChanged) {
      // Local was modified after our last sync — treat as conflict.
      // The remote copy is gone, so smart_conflict would stat a key that is not
      // there, throw, and wedge the sync in a permanent error state. Keep local.
      return "conflict_modified_then_keep_local";
    }
    return "remote_is_deleted_thus_also_delete_local";
  }

  // ── Both present with history → compare each side to baseline ────────────
  if (hasLocal && hasRemote && hasPrev) {
    // A folder has no content, and its timestamps are provider-invented: S3
    // synthesizes folders from object keys, so the value recorded by mkdir and
    // the value reported by the next walk never agree. Present on both sides
    // with history means there is nothing to do.
    if (node.key.endsWith("/")) return "equal";

    const localChanged =
      mtimeChanged(local.mtimeCli, prevSync.mtimeCli) ||
      local.sizeRaw !== prevSync.sizeRaw;

    const remoteBaselineSize = remote.sizeEnc !== undefined ? (prevSync.sizeEnc ?? prevSync.sizeRaw) : prevSync.sizeRaw;
    const remoteChanged =
      mtimeChanged(remote.mtimeSvr, prevSync.mtimeSvr) ||
      mtimeChanged(remote.mtimeCli, prevSync.mtimeCli) ||
      remote.sizeRaw !== remoteBaselineSize;

    if (!localChanged && !remoteChanged) return "equal";
    if (localChanged && !remoteChanged) return "local_is_modified_then_push";
    if (!localChanged && remoteChanged) return "remote_is_modified_then_pull";

    // Both changed → true conflict
    return resolveModifiedConflict(conflictAction, local, remote);
  }

  return "equal";
};

const resolveCreatedConflict = (
  action: ConflictActionType,
  local: Entity | undefined,
  remote: Entity | undefined
): DecisionTypeForMixedEntity => {
  if (action === "keep_newer") {
    const side = newerSide(local?.mtimeCli, remote?.mtimeCli ?? remote?.mtimeSvr);
    return side === "local"
      ? "conflict_created_then_keep_local"
      : "conflict_created_then_keep_remote";
  }
  if (action === "keep_larger") {
    const side = largerSide(local?.sizeRaw, remote?.sizeRaw);
    return side === "local"
      ? "conflict_created_then_keep_local"
      : "conflict_created_then_keep_remote";
  }
  return "conflict_created_then_smart_conflict";
};

const resolveModifiedConflict = (
  action: ConflictActionType,
  local: Entity | undefined,
  remote: Entity | undefined
): DecisionTypeForMixedEntity => {
  if (action === "keep_newer") {
    const side = newerSide(local?.mtimeCli, remote?.mtimeCli ?? remote?.mtimeSvr);
    return side === "local"
      ? "conflict_modified_then_keep_local"
      : "conflict_modified_then_keep_remote";
  }
  if (action === "keep_larger") {
    const side = largerSide(local?.sizeRaw, remote?.sizeRaw);
    return side === "local"
      ? "conflict_modified_then_keep_local"
      : "conflict_modified_then_keep_remote";
  }
  return "conflict_modified_then_smart_conflict";
};

/**
 * applySyncDirection constrains a bidirectional decision to the configured
 * one-way mode. Push modes treat local as the source of truth: nothing is ever
 * downloaded or deleted locally, conflicts resolve to the local copy, and a
 * remote-side deletion is answered by re-uploading the local file. Pull modes
 * mirror that with remote as the source of truth. The plain "only" modes do
 * not propagate deletions at all; the "and delete" modes propagate deletions
 * in their own direction only.
 *
 * "conflict_created_then_do_nothing" preserves the node's baseline row without
 * any I/O (the executor commits prevSync as-is), so a suppressed operation
 * stays suppressed on every following sync instead of churning the baseline.
 *
 * Any value outside the four one-way modes (including an unrecognized string
 * from an imported config) behaves as bidirectional, which is the pre-existing
 * behavior for every stored value.
 */
export const applySyncDirection = (
  decision: DecisionTypeForMixedEntity,
  direction: SyncDirectionType
): DecisionTypeForMixedEntity => {
  const isPush =
    direction === "incremental_push_only" ||
    direction === "incremental_push_and_delete_only";
  const isPull =
    direction === "incremental_pull_only" ||
    direction === "incremental_pull_and_delete_only";

  if (isPush) {
    if (
      decision === "remote_is_created_then_pull" ||
      decision === "remote_is_modified_then_pull"
    ) {
      return "conflict_created_then_do_nothing";
    }
    if (decision === "remote_is_deleted_thus_also_delete_local") {
      return "conflict_modified_then_keep_local";
    }
    if (
      decision === "local_is_deleted_thus_also_delete_remote" &&
      direction === "incremental_push_only"
    ) {
      return "conflict_created_then_do_nothing";
    }
    if (
      decision === "conflict_created_then_keep_remote" ||
      decision === "conflict_created_then_smart_conflict"
    ) {
      return "conflict_created_then_keep_local";
    }
    if (
      decision === "conflict_modified_then_keep_remote" ||
      decision === "conflict_modified_then_smart_conflict"
    ) {
      return "conflict_modified_then_keep_local";
    }
    return decision;
  }

  if (isPull) {
    if (
      decision === "local_is_created_then_push" ||
      decision === "local_is_modified_then_push"
    ) {
      return "conflict_created_then_do_nothing";
    }
    if (decision === "local_is_deleted_thus_also_delete_remote") {
      return "conflict_modified_then_keep_remote";
    }
    if (
      decision === "remote_is_deleted_thus_also_delete_local" &&
      direction === "incremental_pull_only"
    ) {
      return "conflict_created_then_do_nothing";
    }
    if (
      decision === "conflict_created_then_keep_local" ||
      decision === "conflict_created_then_smart_conflict"
    ) {
      return "conflict_created_then_keep_remote";
    }
    if (
      decision === "conflict_modified_then_keep_local" ||
      decision === "conflict_modified_then_smart_conflict"
    ) {
      return "conflict_modified_then_keep_remote";
    }
    return decision;
  }

  return decision;
};
