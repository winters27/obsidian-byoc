import type { FakeFs } from "../fsAll";
import type { FakeFsEncrypt } from "../fsEncrypt";
import type { FakeFsLocal } from "../fsLocal";
import type { InternalDBs } from "../localdb";
import type { Profiler } from "../profiler";
import type {
  BYOCPluginSettings,
  DecisionTypeForMixedEntity,
  Entity,
  MixedEntity,
  SyncTriggerSourceType,
} from "../baseTypes";
import { determineSyncDecision } from "./planner";
import { generateConflictFileName } from "./conflict";
import { copyFileOrFolder } from "../copyLogic";
import { shouldSyncPath } from "./pathFilter";

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

// ─── Rename Detection ─────────────────────────────────────────────────────────
// Conservative bidirectional rename matching using composite-key grouping.
// A rename match requires ALL of the following:
//   1. sizeRaw > 0 (excludes empty files)
//   2. !key.endsWith("/") (excludes folders)
//   3. sizeRaw matches exactly (byte-for-byte)
//   4. mtimeCli within RENAME_MTIME_TOLERANCE_MS (2s — OS preserves on rename)
//   5. Exactly 1 delete + 1 create in the composite group (no ambiguity)
//   6. Provider supports rename (supportsRename() === true)

const RENAME_MTIME_TOLERANCE_MS = 2000;

function matchRenames(
  actions: MixedEntity[],
  opts: {
    deleteDecision: string;
    createDecision: string;
    renameDecision: DecisionTypeForMixedEntity;
    getDeleteMeta: (n: MixedEntity) => { sizeRaw: number; mtimeCli: number };
    getCreateMeta: (n: MixedEntity) => { sizeRaw: number; mtimeCli: number };
  }
): void {
  // Build composite-key groups: ${sizeRaw}:${floor(mtimeCli / tolerance)}
  const groups = new Map<string, { deletes: number[]; creates: number[] }>();

  const compositeKey = (size: number, mtime: number): string =>
    `${size}:${Math.floor(mtime / RENAME_MTIME_TOLERANCE_MS)}`;

  for (let i = 0; i < actions.length; i++) {
    const node = actions[i];
    if (node.key.endsWith("/")) continue; // Exclude folders

    if (node.decision === opts.deleteDecision && node.prevSync) {
      const meta = opts.getDeleteMeta(node);
      if (meta.sizeRaw <= 0) continue; // Exclude empty files
      const key = compositeKey(meta.sizeRaw, meta.mtimeCli);
      if (!groups.has(key)) groups.set(key, { deletes: [], creates: [] });
      groups.get(key)!.deletes.push(i);
    } else if (node.decision === opts.createDecision) {
      const meta = opts.getCreateMeta(node);
      if (meta.sizeRaw <= 0) continue; // Exclude empty files
      const key = compositeKey(meta.sizeRaw, meta.mtimeCli);
      if (!groups.has(key)) groups.set(key, { deletes: [], creates: [] });
      groups.get(key)!.creates.push(i);
    }
  }

  // Only match groups with exactly 1:1 (no ambiguity tolerated)
  const indicesToRemove = new Set<number>();
  const renames: MixedEntity[] = [];

  for (const [, group] of groups) {
    if (group.deletes.length !== 1 || group.creates.length !== 1) continue;

    const delIdx = group.deletes[0];
    const crtIdx = group.creates[0];
    const delNode = actions[delIdx];
    const crtNode = actions[crtIdx];

    indicesToRemove.add(delIdx);
    indicesToRemove.add(crtIdx);

    renames.push({
      key: crtNode.key,           // New path
      renameFrom: delNode.key,    // Old path
      decision: opts.renameDecision,
      prevSync: delNode.prevSync,
      local: crtNode.local,
      remote: crtNode.remote,
    });
  }

  // Remove matched pairs in reverse index order to preserve indices during splice
  const sortedIndices = [...indicesToRemove].sort((a, b) => b - a);
  for (const idx of sortedIndices) {
    actions.splice(idx, 1);
  }

  // Append rename actions (they'll fall into the files bucket in sortSyncActions)
  actions.push(...renames);
}

function detectRenames(
  actions: MixedEntity[],
  canRename: boolean
): MixedEntity[] {
  if (!canRename) return actions;

  const result = [...actions];

  // === Local-side renames ===
  // User renamed locally: shows up as local_is_deleted + local_is_created
  matchRenames(result, {
    deleteDecision: "local_is_deleted_thus_also_delete_remote",
    createDecision: "local_is_created_then_push",
    renameDecision: "rename_local_to_remote",
    getDeleteMeta: (n) => ({
      sizeRaw: n.prevSync!.sizeRaw,
      mtimeCli: n.prevSync!.mtimeCli ?? 0,
    }),
    getCreateMeta: (n) => ({
      sizeRaw: n.local!.sizeRaw,
      mtimeCli: n.local!.mtimeCli ?? 0,
    }),
  });

  // === Remote-side renames ===
  // Another device renamed remotely: shows up as remote_is_deleted + remote_is_created
  // Uses mtimeCli (client-set timestamp, preserved by most providers on move).
  // S3 is excluded upstream via supportsRename() since copy+delete destroys mtimeCli.
  matchRenames(result, {
    deleteDecision: "remote_is_deleted_thus_also_delete_local",
    createDecision: "remote_is_created_then_pull",
    renameDecision: "rename_remote_to_local",
    getDeleteMeta: (n) => ({
      sizeRaw: n.prevSync!.sizeRaw,
      mtimeCli: n.prevSync!.mtimeCli ?? 0,
    }),
    getCreateMeta: (n) => ({
      sizeRaw: n.remote!.sizeRaw,
      mtimeCli: n.remote!.mtimeCli ?? 0,
    }),
  });

  return result;
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

    // Phase 1.5: Path Filtering
    const ignorePaths = settings.ignorePaths ?? [];
    const onlyAllowPaths = settings.onlyAllowPaths ?? [];
    if (ignorePaths.length > 0 || onlyAllowPaths.length > 0) {
      for (const [key] of nodes) {
        if (!shouldSyncPath(key, ignorePaths, onlyAllowPaths)) {
          nodes.delete(key);
        }
      }
    }

    // Phase 2: Planner
    const unsortedActions = Array.from(nodes.values()).map(node => {
      node.decision = determineSyncDecision(node, settings.conflictAction || "smart_conflict");
      return node;
    });

    // M1: Enforce folder-before-file creation order, file-before-folder delete order.
    let syncActions = sortSyncActions(unsortedActions);

    // M1.5: Rename Detection — converts delete+create pairs into single rename ops.
    // Must run AFTER sortSyncActions (which establishes the decision classification)
    // and BEFORE the protection check (renames are not destructive).
    const canRename = remoteFsTarget.supportsRename();
    syncActions = detectRenames(syncActions, canRename);

    // M2: Protection — count operations that destroy or overwrite local content.
    // Rename decisions are explicitly skipped — a rename is a path change, not destruction.
    const allFileCount = nodes.size;
    
    if (allFileCount > 0) {
      let destructiveCount = 0;
      for (const action of syncActions) {
        const d = action.decision;
        if (!d || d === "equal" || d === "only_history") continue;

        // Skip rename decisions — non-destructive path changes
        if (d === "rename_local_to_remote" || d === "rename_remote_to_local") continue;

        // Deletes (either side) are always destructive
        if (d.includes("delete")) {
          destructiveCount++;
          continue;
        }

        // Pulls that OVERWRITE an existing local file
        if (d === "remote_is_modified_then_pull" && action.local !== undefined) {
          destructiveCount++;
          continue;
        }

        // Conflict resolutions that overwrite local with remote content
        if ((d.includes("keep_remote") || d.includes("smart_conflict")) && action.local !== undefined) {
          destructiveCount++;
          continue;
        }
      }

      const protectErr = getProtectError(
        settings.protectModifyPercentage || 50,
        destructiveCount,
        allFileCount
      );
      if (protectErr !== "") {
        throw Error(`Protection Triggered: ${protectErr}`);
      }
    }

    // Phase 3: Execution Engine
    await statusBarFunc(triggerSource, 7, true); // Exchanging data

    const successfulCommits: Entity[] = [];
    let hadErrors = false;
    let counter = 0;

    for (const node of syncActions) {
      const decision = node.decision;
      if (decision === "equal" || decision === "only_history") {
        // M3: Commit the freshest known entity, not the stale prevSync snapshot.
        const commitEntity = node.local ?? node.remote ?? node.prevSync;
        if (commitEntity) successfulCommits.push(commitEntity);
        continue;
      }

      await callbackSyncProcess(triggerSource, ++counter, syncActions.length, node.key, decision || "unknown");

      try {
        if (decision === "local_is_created_then_push" || decision === "local_is_modified_then_push") {
          const res = await copyFileOrFolder(node.key, fsLocal, remoteFsTarget);
          successfulCommits.push({
            ...res.entity,
            keyRaw: node.key,
            mtimeCli: node.local!.mtimeCli,
            sizeRaw: node.local!.sizeRaw, // baseline anchored to plaintext size
            sizeEnc: res.entity.sizeRaw,  // ciphertext size
          });
        }
        else if (decision === "remote_is_created_then_pull" || decision === "remote_is_modified_then_pull") {
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({
            ...res.entity,
            keyRaw: node.key,
            mtimeSvr: node.remote!.mtimeSvr,
            sizeRaw: res.entity.sizeRaw,
            sizeEnc: node.remote!.sizeEnc ?? node.remote!.sizeRaw,
          });
        }
        else if (decision === "remote_is_deleted_thus_also_delete_local") {
          await fsLocal.rm(node.key);
          // Omit from successfulCommits — clears baseline so next sync won't re-examine
        }
        else if (decision === "local_is_deleted_thus_also_delete_remote") {
          await remoteFsTarget.rm(node.key);
          // Omit from successfulCommits — clears baseline
        }
        // ── Rename handlers ──────────────────────────────────────────────────
        else if (decision === "rename_local_to_remote" && node.renameFrom) {
          // User renamed a file locally — move it on the remote to match.
          await remoteFsTarget.rename(node.renameFrom, node.key);
          // stat() the new path to capture the fresh mtimeSvr from the provider.
          const freshEntity = await remoteFsTarget.stat(node.key);
          successfulCommits.push({
            ...freshEntity,
            keyRaw: node.key,
            mtimeCli: node.prevSync?.mtimeCli ?? node.local?.mtimeCli,
            sizeRaw: node.prevSync?.sizeRaw ?? node.local?.sizeRaw ?? freshEntity.sizeRaw,
            sizeEnc: node.prevSync?.sizeEnc ?? freshEntity.sizeRaw,
          });
        }
        else if (decision === "rename_remote_to_local" && node.renameFrom) {
          // A remote device renamed a file — update local path to match.
          await fsLocal.rename(node.renameFrom, node.key);
          const freshEntity = await fsLocal.stat(node.key);
          successfulCommits.push({
            ...freshEntity,
            keyRaw: node.key,
            mtimeSvr: node.prevSync?.mtimeSvr ?? node.remote?.mtimeSvr,
            sizeRaw: freshEntity.sizeRaw,
            sizeEnc: node.prevSync?.sizeEnc,
          });
        }
        // ─────────────────────────────────────────────────────────────────────
        else if (decision?.includes("conflict") && decision?.includes("smart_conflict")) {
          const cName = generateConflictFileName(node.key);
          if (!node.key.endsWith("/")) {
            const localContent = await fsLocal.readFile(node.key);
            const localStat = await fsLocal.stat(node.key);
            await fsLocal.writeFile(
              cName,
              localContent,
              localStat.mtimeCli ?? Date.now(),
              localStat.ctimeCli ?? localStat.mtimeCli ?? Date.now()
            );
          }
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({
            ...res.entity,
            keyRaw: node.key,
            mtimeSvr: node.remote!.mtimeSvr,
            sizeRaw: res.entity.sizeRaw,
            sizeEnc: node.remote!.sizeEnc ?? node.remote!.sizeRaw,
          });
        }
        else if (decision?.includes("keep_local")) {
          const res = await copyFileOrFolder(node.key, fsLocal, remoteFsTarget);
          successfulCommits.push({
            ...res.entity,
            keyRaw: node.key,
            mtimeCli: node.local!.mtimeCli,
            sizeRaw: node.local!.sizeRaw,
            sizeEnc: res.entity.sizeRaw,
          });
        }
        else if (decision?.includes("keep_remote")) {
          const res = await copyFileOrFolder(node.key, remoteFsTarget, fsLocal);
          successfulCommits.push({
            ...res.entity,
            keyRaw: node.key,
            mtimeSvr: node.remote!.mtimeSvr,
            sizeRaw: res.entity.sizeRaw,
            sizeEnc: node.remote!.sizeEnc ?? node.remote!.sizeRaw,
          });
        }
      } catch (e) {
        // Bug Fix #3: Track individual execution errors.
        // The file stays in broken state — next sync will retry it.
        hadErrors = true;
        console.error(`BYOC Engine failed handling file ${node.key}:`, e);
      }
    }

    // Phase 4: Committing Baseline
    // Bug Fix #3: Gate baseline commit on sync completeness.
    //
    // isInitialSync: no prevSync records — this is the very first sync.
    // On initial sync + errors: do NOT commit ANY baseline. The next sync
    // will retry from scratch as a fresh initial sync, preventing a partial
    // baseline from triggering destructive deletes on subsequent runs.
    //
    // On subsequent syncs + errors: merge successful commits with the old
    // baseline for failed files (preserving their retry-ability).
    const isInitialSync = prevSyncItems.length === 0;

    if (isInitialSync && hadErrors) {
      console.warn("[BYOC] Initial sync incomplete — not committing partial baseline. Retry will start fresh.");
      // Intentionally do NOT write to prevSyncRecordsTbl
    } else if (!hadErrors) {
      // Clean run — commit the full successful set
      await db.prevSyncRecordsTbl.setItem(profileID, successfulCommits);
    } else {
      // Partial failure on a subsequent sync — merge: successful commits
      // take priority; failed files retain their previous baseline entry.
      const committedKeys = new Set(successfulCommits.map(e => e.keyRaw));
      const merged = [
        ...successfulCommits,
        ...prevSyncItems.filter(e => !committedKeys.has(e.keyRaw))
      ];
      await db.prevSyncRecordsTbl.setItem(profileID, merged);
    }

    await notifyFunc(triggerSource, 8); // finish
    await statusBarFunc(triggerSource, 8, true);

  } catch (err: unknown) {
    console.error("BYOC Sync Error: ", err);
    const errAsError = err instanceof Error ? err : new Error(String(err));
    await errNotifyFunc(triggerSource, errAsError);
    await statusBarFunc(triggerSource, 8, false);
  } finally {
    await markIsSyncingFunc(false);
  }
}
