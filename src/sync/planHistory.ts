import type { MixedEntity, DecisionTypeForMixedEntity } from "../baseTypes";
import { unixTimeToStr } from "../misc";

/**
 * The slice of the sync-plans table this module needs. The syncer passes the
 * real localforage table; a test can pass a keyed fake or nothing at all.
 */
export interface SyncPlansTable {
  setItem<T>(key: string, value: T): Promise<unknown>;
}

/** Decisions that move or remove nothing. Everything else counts as a change. */
const NO_CHANGE: ReadonlySet<DecisionTypeForMixedEntity> = new Set<DecisionTypeForMixedEntity>([
  "only_history",
  "equal",
  "folder_existed_both_then_do_nothing",
  "folder_to_skip",
  "conflict_created_then_do_nothing",
  "local_is_created_too_large_then_do_nothing",
  "remote_is_created_too_large_then_do_nothing",
]);

export const isChange = (decision: DecisionTypeForMixedEntity | undefined): boolean =>
  decision !== undefined && !NO_CHANGE.has(decision);

export interface SyncPlanMeta {
  triggerSource: string;
  remoteType: string;
  syncDirection: string;
  conflictAction: string;
}

/**
 * The plan as the debug exporter reads it: one entry per path carrying the
 * three entities and the decision, plus a "/$@meta" entry. The exporter's
 * "change part" view keeps entries whose `change` is true.
 */
export const buildSyncPlan = (
  actions: MixedEntity[],
  meta: SyncPlanMeta,
  now = Date.now()
): Record<string, unknown> => {
  const plan: Record<string, unknown> = {
    "/$@meta": { ...meta, ts: now, tsFmt: unixTimeToStr(now), entries: actions.length },
  };
  for (const a of actions) {
    plan[a.key] = {
      key: a.key,
      decision: a.decision,
      decisionBranch: a.decisionBranch,
      change: isChange(a.decision),
      renameFrom: a.renameFrom,
      local: a.local,
      remote: a.remote,
      prevSync: a.prevSync,
      sideNotes: a.sideNotes,
    };
  }
  return plan;
};

/**
 * Stores one plan under `<vaultRandomID>\t<ts>`, the key the exporter and the
 * expiry sweep already use. Plan history is a debugging aid, so it never
 * fails a sync: a missing table means no history, and a write error is
 * logged and dropped.
 */
let lastRecordedTs = 0;

export const recordSyncPlan = async (
  tbl: SyncPlansTable | undefined,
  vaultRandomID: string,
  plan: Record<string, unknown>,
  now = Date.now()
): Promise<void> => {
  if (tbl === undefined) return;
  // Two syncs inside one millisecond would share a key and the later plan
  // would replace the earlier one, so the timestamp only ever moves forward.
  if (now <= lastRecordedTs) now = lastRecordedTs + 1;
  lastRecordedTs = now;
  const meta = plan["/$@meta"] as { remoteType?: string } | undefined;
  try {
    await tbl.setItem(`${vaultRandomID}\t${now}`, {
      ts: now,
      tsFmt: unixTimeToStr(now),
      vaultRandomID,
      remoteType: meta?.remoteType ?? "unknown",
      syncPlan: JSON.stringify(plan, null, 2),
    });
  } catch (err) {
    console.warn("[BYOC] Could not record the sync plan history:", err);
  }
};
