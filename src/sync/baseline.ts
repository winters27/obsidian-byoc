import type { Entity } from "../baseTypes";

/**
 * The slice of the prev-sync table the baseline needs. Kept minimal so a test
 * can hand over a plain keyed fake, and so this module never imports the
 * localforage-backed database.
 */
export interface PrevSyncRecordsTable {
  getItem<T>(key: string): Promise<T | null | undefined>;
  setItem<T>(key: string, value: T): Promise<unknown>;
  removeItem(key: string): Promise<void>;
}

/** Where one vault's baseline for one provider profile lives. */
export const prevSyncRecordsKey = (vaultRandomID: string, profileID: string) =>
  `${vaultRandomID}\t${profileID}`;

/**
 * Loads this vault's baseline.
 *
 * Releases up to 1.0.17 stored one baseline per provider profile for the whole
 * machine, under the bare `profileID`. Every vault syncing to the same provider
 * type therefore shared it: the second vault read the first one's rows as
 * "present in the baseline, gone locally" and planned deleting them on its own
 * remote. The legacy row is adopted, once, by the first vault whose files it
 * describes (at least half of its file rows exist locally), and removed after
 * adoption so no other vault can inherit it. A vault the row does not describe,
 * such as a fresh device or an unrelated vault, starts with no baseline, which
 * the planner already handles without deleting anything.
 */
export const loadPrevSyncRecords = async (
  tbl: PrevSyncRecordsTable,
  vaultRandomID: string,
  profileID: string,
  localKeys: Iterable<string>
): Promise<Entity[]> => {
  const own = await tbl.getItem<Entity[]>(
    prevSyncRecordsKey(vaultRandomID, profileID)
  );
  if (own != null) return own;

  const legacy = await tbl.getItem<Entity[]>(profileID);
  if (legacy == null || legacy.length === 0) return [];

  const present = new Set(localKeys);
  const fileRows = legacy.filter((e) => !e.keyRaw.endsWith("/"));
  const matched = fileRows.filter((e) => present.has(e.keyRaw)).length;
  if (fileRows.length === 0 || matched * 2 < fileRows.length) {
    console.warn(
      `[BYOC] A pre-1.0.18 baseline for ${profileID} exists but describes another vault (${matched} of ${fileRows.length} files present here); starting this vault without one.`
    );
    return [];
  }

  await tbl.setItem(prevSyncRecordsKey(vaultRandomID, profileID), legacy);
  await tbl.removeItem(profileID);
  console.info(
    `[BYOC] Adopted the pre-1.0.18 baseline for ${profileID} into this vault (${matched} of ${fileRows.length} files present).`
  );
  return legacy;
};

export const savePrevSyncRecords = async (
  tbl: PrevSyncRecordsTable,
  vaultRandomID: string,
  profileID: string,
  items: Entity[]
): Promise<void> => {
  await tbl.setItem(prevSyncRecordsKey(vaultRandomID, profileID), items);
};
