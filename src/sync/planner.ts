import type { MixedEntity, ConflictActionType, DecisionTypeForMixedEntity } from "../baseTypes";

// Two timestamps are considered equal if within 2 seconds of each other.
// Necessary because providers and local FS have different mtime precision.
const MTIME_TOLERANCE_MS = 2000;

const mtimeChanged = (current?: number, baseline?: number): boolean => {
  if (current === undefined || baseline === undefined) return false;
  return Math.abs(current - baseline) > MTIME_TOLERANCE_MS;
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
    const remoteChanged =
      mtimeChanged(remote.mtimeSvr, prevSync.mtimeSvr) ||
      mtimeChanged(remote.mtimeCli, prevSync.mtimeCli) ||
      remote.sizeRaw !== prevSync.sizeRaw;

    if (remoteChanged) {
      // Remote was modified after our last sync — treat as conflict
      return resolveModifiedConflict(conflictAction, local, remote);
    }
    return "local_is_deleted_thus_also_delete_remote";
  }

  // ── Remote missing, prev exists → remote was deleted ─────────────────────
  if (hasLocal && !hasRemote && hasPrev) {
    const localChanged =
      mtimeChanged(local.mtimeCli, prevSync.mtimeCli) ||
      local.sizeRaw !== prevSync.sizeRaw;

    if (localChanged) {
      // Local was modified after our last sync — treat as conflict
      return resolveModifiedConflict(conflictAction, local, remote);
    }
    return "remote_is_deleted_thus_also_delete_local";
  }

  // ── Both present with history → compare each side to baseline ────────────
  if (hasLocal && hasRemote && hasPrev) {
    const localChanged =
      mtimeChanged(local.mtimeCli, prevSync.mtimeCli) ||
      local.sizeRaw !== prevSync.sizeRaw;

    const remoteChanged =
      mtimeChanged(remote.mtimeSvr, prevSync.mtimeSvr) ||
      mtimeChanged(remote.mtimeCli, prevSync.mtimeCli) ||
      remote.sizeRaw !== prevSync.sizeRaw;

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
  local: any,
  remote: any
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
  local: any,
  remote: any
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
