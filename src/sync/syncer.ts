import type { FakeFs } from "../fsAll";
import type { FakeFsEncrypt } from "../fsEncrypt";
import type { FakeFsLocal } from "../fsLocal";
import type { InternalDBs } from "../localdb";
import type { Profiler } from "../profiler";
import type { BYOCPluginSettings, SyncTriggerSourceType, Entity, MixedEntity } from "../baseTypes";
import { determineSyncDecision } from "./planner";
import { generateConflictFileName } from "./conflict";
import { copyFileOrFolder } from "../copyLogic";

// ─── Folder-aware sorter ───────────────────────────────────────────────────────
// Correct execution order to prevent parent-before-child violations:
//   1. Folders to CREATE — ascending depth (parents first)
//   2. Files — any order
//   3. Folders to DELETE — descending depth (children first)
const folderDepth = (key: string) => key.split("/").length - 1;

function sortSyncActions(actions: MixedEntity[]): MixedEntity[] {
  const foldersToCreate: MixedEntity[] = [];
  const files: MixedEntity[] = [];
  const foldersToDelete: MixedEntity[] = [];
  const rest: MixedEntity[] = [];

  for (const node of actions) {
    const isFolder = node.key.endsWith("/");
    const d = node.decision;

    if (isFolder) {
      const isCreate =
        d === "folder_to_be_created" ||
        d === "folder_existed_local_then_also_create_remote" ||
        d === "folder_existed_remote_then_also_create_local" ||
        d === "local_is_created_then_push" ||
        d === "remote_is_created_then_pull";

      const isDelete =
        d === "folder_to_be_deleted_on_both" ||
        d === "folder_to_be_deleted_on_remote" ||
        d === "folder_to_be_deleted_on_local" ||
        d === "remote_is_deleted_thus_also_delete_local" ||
        d === "local_is_deleted_thus_also_delete_remote";

      if (isCreate) {
        foldersToCreate.push(node);
      } else if (isDelete) {
        foldersToDelete.push(node);
      } else {
        rest.push(node);
      }
    } else {
      files.push(node);
    }
  }

  foldersToCreate.sort((a, b) => folderDepth(a.key) - folderDepth(b.key));
  foldersToDelete.sort((a, b) => folderDepth(b.key) - folderDepth(a.key));

  return [...foldersToCreate, ...files, ...foldersToDelete, ...rest];
}

/**
 * BYOC — Sync Engine orchestrator. (Clean-Room Implementation)
 */
export async function syncer(
  fsLocal: FakeFsLocal,
  fsRemote: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  profiler: Profiler | undefined,
  db: InternalDBs,
  triggerSource: SyncTriggerSourceType,
  profileID: string,
  vaultRandomID: string,
  configDir: string,
  settings: BYOCPluginSettings,
  pluginVersion: string,
  configSaver: () => Promise<any>,
  getProtectError: (
    protectModifyPercentage: number,
    realModifyDeleteCount: number,
    allFilesCount: number
  ) => string,
  markIsSyncingFunc: (isSyncing: boolean) => Promise<void>,
  notifyFunc: (s: SyncTriggerSourceType, step: number) => Promise<void>,
  errNotifyFunc: (s: SyncTriggerSourceType, error: Error) => Promise<void>,
  ribbonFunc: (s: SyncTriggerSourceType, step: number) => Promise<void>,
  statusBarFunc: (s: SyncTriggerSourceType, step: number, everythingOk: boolean) => Promise<void>,
  callbackSyncProcess: (
    s: SyncTriggerSourceType,
    realCounter: number,
    realTotalCount: number,
    pathName: string,
    decision: string
  ) => Promise<void>
): Promise<void> {
  await markIsSyncingFunc(true);
  try {
    // Phase 1: Fetching
    await statusBarFunc(triggerSource, 1, true); // Prepare
    const remoteFsTarget = settings.password !== "" ? fsEncrypt : fsRemote;

    const [localWalk, remoteWalk, prevSyncItemsRaw] = await Promise.all([
      fsLocal.walk(),
      remoteFsTarget.walk(),
      db.prevSyncRecordsTbl.getItem<Entity[]>(profileID)
    ]);

    const prevSyncItems = prevSyncItemsRaw || [];

    // Matrix Assembly
    const nodes = new Map<string, MixedEntity>();

    // Seed missing history
    for (const p of prevSyncItems) {
      if (!nodes.has(p.keyRaw)) {
        nodes.set(p.keyRaw, { key: p.keyRaw, prevSync: p });
      } else {
        nodes.get(p.keyRaw)!.prevSync = p;
      }
    }

    for (const l of localWalk) {
      if (!nodes.has(l.keyRaw)) {
        nodes.set(l.keyRaw, { key: l.keyRaw, local: l });
      } else {
        nodes.get(l.keyRaw)!.local = l;
      }
    }

    for (const r of remoteWalk) {
      if (!nodes.has(r.keyRaw)) {
        nodes.set(r.keyRaw, { key: r.keyRaw, remote: r });
      } else {
        nodes.get(r.keyRaw)!.remote = r;
      }
    }

    // Phase 2: Planner
    const unsortedActions = Array.from(nodes.values()).map(node => {
      node.decision = determineSyncDecision(node, settings.conflictAction || "smart_conflict");
      return node;
    });

    // M1: Enforce folder-before-file creation order, file-before-folder delete order.
    const syncActions = sortSyncActions(unsortedActions);

    // M2: Skip protection check on empty vault (avoids division by zero/NaN).
    if (localWalk.length > 0) {
      let deleteModifyCount = 0;
      for (const action of syncActions) {
        if (action.decision?.includes("delete") || action.decision?.includes("pull")) {
          deleteModifyCount++;
        }
      }

      const protectErr = getProtectError(settings.protectModifyPercentage || 50, deleteModifyCount, localWalk.length);
      if (protectErr !== "") {
        throw Error(`Protection Triggered: ${protectErr}`);
      }
    }

    // Phase 3: Execution Engine
    await statusBarFunc(triggerSource, 7, true); // Exchanging data

    const successfulCommits: Entity[] = [];
    let counter = 0;

    for (const node of syncActions) {
      const decision = node.decision;
      if (decision === "equal" || decision === "only_history") {
        // M3: Commit the freshest known entity, not the stale prevSync snapshot.
        // Using stale prevSync would cause false-change detection on next sync
        // if provider clocks have drifted slightly.
        const commitEntity = node.local ?? node.remote ?? node.prevSync;
        if (commitEntity) successfulCommits.push(commitEntity);
        continue;
      }

      await callbackSyncProcess(triggerSource, ++counter, syncActions.length, node.key, decision || "unknown");

      try {
        if (decision === "local_is_created_then_push" || decision === "local_is_modified_then_push") {
          const res = await copyFileOrFolder(node.key, fsLocal, remoteFsTarget);
          successfulCommits.push({ ...node.local!, keyRaw: node.key, mtimeSvr: res.entity.mtimeSvr });
        }
        else if (decision === "remote_is_created_then_pull" || decision === "remote_is_modified_then_pull") {
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({ ...node.remote!, keyRaw: node.key, mtimeCli: res.entity.mtimeCli });
        }
        else if (decision === "remote_is_deleted_thus_also_delete_local") {
          await fsLocal.rm(node.key);
          // Omit from successfulCommits — clears baseline so next sync won't re-examine
        }
        else if (decision === "local_is_deleted_thus_also_delete_remote") {
          await remoteFsTarget.rm(node.key);
          // Omit from successfulCommits — clears baseline
        }
        else if (decision?.includes("conflict") && decision?.includes("smart_conflict")) {
          // Smart conflict: preserve local as a timestamped backup, then pull remote.
          const cName = generateConflictFileName(node.key);
          if (!node.key.endsWith("/")) {
            // Read the current local content and write it to the conflict-named path.
            const localContent = await fsLocal.readFile(node.key);
            const localStat = await fsLocal.stat(node.key);
            await fsLocal.writeFile(
              cName,
              localContent,
              localStat.mtimeCli ?? Date.now(),
              localStat.ctimeCli ?? localStat.mtimeCli ?? Date.now()
            );
          }
          // Pull remote over the actual local file — now safe because local is backed up.
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({ ...node.remote!, keyRaw: node.key, mtimeCli: res.entity.mtimeCli });
        }
        else if (decision?.includes("keep_local")) {
          const res = await copyFileOrFolder(node.key, fsLocal, remoteFsTarget);
          successfulCommits.push({ ...node.local!, keyRaw: node.key, mtimeSvr: res.entity.mtimeSvr });
        }
        else if (decision?.includes("keep_remote")) {
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({ ...node.remote!, keyRaw: node.key, mtimeCli: res.entity.mtimeCli });
        }
      } catch (e) {
        // If an operation fails, bypass pushing to successfulCommits.
        // The file stays in broken state — next sync will retry it.
        console.error(`BYOC Engine failed handling file ${node.key}:`, e);
      }
    }

    // Phase 4: Committing Baseline
    // Atomically save mtimes of all successfully synced files for 3-way diff next run.
    await db.prevSyncRecordsTbl.setItem(profileID, successfulCommits);

    await notifyFunc(triggerSource, 8); // finish
    await statusBarFunc(triggerSource, 8, true);

  } catch (err: any) {
    console.error("BYOC Sync Error: ", err);
    await errNotifyFunc(triggerSource, err);
    await statusBarFunc(triggerSource, 8, false);
  } finally {
    await markIsSyncingFunc(false);
  }
}
