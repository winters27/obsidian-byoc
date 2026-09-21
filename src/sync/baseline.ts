import type { Entity } from "../baseTypes";

/**
 * The slice of the prev-sync table the baseline needs. Kept minimal so a test
 * can hand over a plain keyed fake, and so this module never imports the
 * localforage-backed database. `keys` is optional: a table that cannot list
 * its keys simply has no Remotely Save history to inherit.
 */
export interface PrevSyncRecordsTable {
  getItem<T>(key: string): Promise<T | null | undefined>;
  setItem<T>(key: string, value: T): Promise<unknown>;
  removeItem(key: string): Promise<void>;
  keys?(): Promise<string[]>;
}

/** Where one vault's baseline for one provider profile lives. */
export const prevSyncRecordsKey = (vaultRandomID: string, profileID: string) =>
  `${vaultRandomID}\t${profileID}`;

/**
 * Remotely Save keeps one row per file under this prefix, in the same
 * database and with the same vault id and profile id formulas, so a vault that
 * used to sync with it carries its history here.
 */
export const remotelySavePrefix = (vaultRandomID: string, profileID: string) =>
  `${vaultRandomID}\t${profileID}\t`;

/** True when at least half of the file rows describe files present locally. */
const describesVault = (
  rows: Entity[],
  present: Set<string>
): { adopt: boolean; matched: number; files: number } => {
  const fileRows = rows.filter((e) => !e.keyRaw.endsWith("/"));
  const matched = fileRows.filter((e) => present.has(e.keyRaw)).length;
  return {
    adopt: fileRows.length > 0 && matched * 2 >= fileRows.length,
    matched,
    files: fileRows.length,
  };
};

/**
 * Loads this vault's baseline, in this order of trust:
 *
 * 1. The vault's own row.
 * 2. The pre-1.0.18 machine-wide row. Releases up to 1.0.17 stored one baseline
 *    per provider profile for the whole machine, under the bare `profileID`, so
 *    every vault syncing to the same provider type shared it: the second vault
 *    read the first one's rows as "in the baseline, gone locally" and planned
 *    deleting them on its own remote. The row is adopted, once, by the first
 *    vault whose files it describes, and removed after adoption so no other
 *    vault can inherit it.
 * 3. Remotely Save's per-file rows for this vault and profile, so a vault that
 *    switches over keeps its sync history instead of starting from scratch.
 *    Those rows are copied, never removed, in case Remotely Save is still in
 *    use.
 *
 * A candidate is adopted only when at least half of its file rows exist
 * locally. A vault the rows do not describe, such as a fresh device or an
 * unrelated vault, starts with no baseline, which the planner already handles
 * without deleting anything.
 */
export const loadPrevSyncRecords = async (
  tbl: PrevSyncRecordsTable,
  vaultRandomID: string,
  profileID: string,
  localKeys: Iterable<string>
): Promise<Entity[]> => {
  const ownKey = prevSyncRecordsKey(vaultRandomID, profileID);
  const own = await tbl.getItem<Entity[]>(ownKey);
  if (own != null) return own;

  const present = new Set(localKeys);

  const legacy = await tbl.getItem<Entity[]>(profileID);
  if (legacy != null && legacy.length > 0) {
    const fit = describesVault(legacy, present);
    if (fit.adopt) {
      await tbl.setItem(ownKey, legacy);
      await tbl.removeItem(profileID);
      console.info(
        `[BYOC] Adopted the pre-1.0.18 baseline for ${profileID} into this vault (${fit.matched} of ${fit.files} files present).`
      );
      return legacy;
    }
    console.warn(
      `[BYOC] A pre-1.0.18 baseline for ${profileID} exists but describes another vault (${fit.matched} of ${fit.files} files present here); leaving it for that vault.`
    );
  }

  if (tbl.keys !== undefined) {
    const prefix = remotelySavePrefix(vaultRandomID, profileID);
    const rsKeys = (await tbl.keys()).filter((k) => k.startsWith(prefix));
    if (rsKeys.length > 0) {
      const rows: Entity[] = [];
      for (const k of rsKeys) {
        const row = await tbl.getItem<Entity>(k);
        if (row != null && typeof row.keyRaw === "string") rows.push(row);
      }
      const fit = describesVault(rows, present);
      if (fit.adopt) {
        await tbl.setItem(ownKey, rows);
        console.info(
          `[BYOC] Inherited Remotely Save's sync history for this vault (${rows.length} rows, ${fit.matched} of ${fit.files} files present).`
        );
        return rows;
      }
      console.warn(
        `[BYOC] Remotely Save history exists for this vault but only ${fit.matched} of ${fit.files} files are present; starting without it.`
      );
    }
  }

  return [];
};

export const savePrevSyncRecords = async (
  tbl: PrevSyncRecordsTable,
  vaultRandomID: string,
  profileID: string,
  items: Entity[]
): Promise<void> => {
  await tbl.setItem(prevSyncRecordsKey(vaultRandomID, profileID), items);
};
