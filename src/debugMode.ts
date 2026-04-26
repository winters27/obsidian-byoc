import type { Vault } from "obsidian";

/** SyncPlanType — local stub; full type defined in Batch 2 sync engine */
type SyncPlanType = Record<string, unknown>;
import {
  DEFAULT_DEBUG_FOLDER,
  DEFAULT_PROFILER_RESULT_FILE_PREFIX,
  DEFAULT_SYNC_PLANS_HISTORY_FILE_PREFIX,
} from "./baseTypes";
import {
  readAllProfilerResultsByVault,
  readAllSyncPlanRecordTextsByVault,
} from "./localdb";
import type { InternalDBs } from "./localdb";
import { mkdirpInVault } from "./misc";

const getSubsetOfSyncPlan = (x: string, onlyChange: boolean) => {
  if (!onlyChange) {
    return x;
  }
  const y: SyncPlanType = JSON.parse(x);
  const z: SyncPlanType = Object.fromEntries(
    Object.entries(y).filter(([key, val]) => {
      if (key === "/$@meta") {
        return true;
      }
      const v = val as { change?: unknown };
      return v.change === undefined || v.change === true;
    })
  );
  return JSON.stringify(z, null, 2);
};

export const exportVaultSyncPlansToFiles = async (
  db: InternalDBs,
  vault: Vault,
  vaultRandomID: string,
  howMany: number,
  onlyChange: boolean
) => {
  console.debug("exporting sync plans");
  await mkdirpInVault(DEFAULT_DEBUG_FOLDER, vault);
  const records = await readAllSyncPlanRecordTextsByVault(db, vaultRandomID);
  let md = "";
  if (records.length === 0) {
    md = "No sync plans history found";
  } else {
    if (howMany <= 0) {
      md =
        "Sync plans found:\n\n" +
        records
          .map(
            (x) => "```json\n" + getSubsetOfSyncPlan(x, onlyChange) + "\n```\n"
          )
          .join("\n");
    } else {
      md =
        "Sync plans found:\n\n" +
        records
          .map(
            (x) => "```json\n" + getSubsetOfSyncPlan(x, onlyChange) + "\n```\n"
          )
          .slice(0, howMany)
          .join("\n");
    }
  }
  const ts = Date.now();
  const filePath = `${DEFAULT_DEBUG_FOLDER}${DEFAULT_SYNC_PLANS_HISTORY_FILE_PREFIX}${ts}.md`;
  await vault.create(filePath, md, {
    mtime: ts,
  });
  console.debug("finish exporting sync plans");
};

export const exportVaultProfilerResultsToFiles = async (
  db: InternalDBs,
  vault: Vault,
  vaultRandomID: string
) => {
  console.debug("exporting profiler results");
  await mkdirpInVault(DEFAULT_DEBUG_FOLDER, vault);
  const records = await readAllProfilerResultsByVault(db, vaultRandomID);
  let md = "";
  if (records.length === 0) {
    md = "No profiler results found";
  } else {
    md =
      "Profiler results found:\n\n" +
      records.map((x) => "```\n" + x + "\n```\n").join("\n");
  }
  const ts = Date.now();
  const filePath = `${DEFAULT_DEBUG_FOLDER}${DEFAULT_PROFILER_RESULT_FILE_PREFIX}${ts}.md`;
  await vault.create(filePath, md, {
    mtime: ts,
  });
  console.debug("finish exporting profiler results");
};
