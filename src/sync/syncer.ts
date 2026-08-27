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
      // Providers that cannot store a client mtime report none; fall back to the
      // server mtime so the composite key can still line up with the delete side.
      mtimeCli: n.remote!.mtimeCli ?? n.remote!.mtimeSvr ?? 0,
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
  configSaver: () => Promise<unknown>,
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
  ) => Promise<void>,
  dryRunSummaryFunc?: (
    byDecision: Record<string, number>,
    totalPlanned: number
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

    // One-time heal. Releases up to 1.0.13 wrote the LOCAL mtime into
    // baseline.mtimeSvr on every unchanged sync, which makes the next sync
    // misread every file as remotely modified. Re-anchor from the live remote,
    // but only for rows whose size and client mtime already agree with it: that
    // is the exact signature of the stale anchor, and any other disagreement is
    // a real change that must reach the planner untouched.
    if (!settings.svrAnchorFixDone) {
      const remoteByKey = new Map(remoteWalk.map((r) => [r.keyRaw, r]));
      for (const p of prevSyncItems) {
        const r = remoteByKey.get(p.keyRaw);
        if (r === undefined) continue;
        // The stale anchor is recognisable: the old code copied the local mtime
        // over the server one, leaving both fields identical. A row where they
        // differ was written correctly and must be left for the planner, so a
        // genuine remote edit is never adopted as the new baseline.
        if (p.mtimeSvr !== p.mtimeCli) continue;
        const baselineSize =
          r.sizeEnc !== undefined ? (p.sizeEnc ?? p.sizeRaw) : p.sizeRaw;
        if (r.sizeRaw !== baselineSize) continue;
        if (
          r.mtimeCli !== undefined &&
          p.mtimeCli !== undefined &&
          Math.abs(r.mtimeCli - p.mtimeCli) > 2000
        ) {
          continue;
        }
        // Mutate in place: the partial-failure merge below re-reads this array.
        p.mtimeSvr = r.mtimeSvr;
      }
    }

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
      node.decision = determineSyncDecision(
        node,
        settings.conflictAction || "smart_conflict",
        settings.syncDirection ?? "bidirectional"
      );
      return node;
    });

    // Encryption safety: an undecryptable remote entry is dropped from the walk,
    // so its local twin looks "remote-deleted" and would be wrongly removed.
    // While any entry failed to decrypt we do not trust remote-absence for any
    // file: abort if nothing decrypted (wrong password/method), otherwise keep
    // the local files and warn.
    if (settings.password !== "" && fsEncrypt.undecryptableKeys.length > 0) {
      const undecryptableCount = fsEncrypt.undecryptableKeys.length;
      if (remoteWalk.length === 0) {
        throw Error(
          `Sync aborted: ${undecryptableCount} encrypted remote ${undecryptableCount === 1 ? "entry" : "entries"} could not be decrypted and none decrypted successfully. Check your password and encryption method. No local files were changed.`
        );
      }
      let suppressed = 0;
      for (const action of unsortedActions) {
        const d = action.decision;
        const looksRemoteDeleted =
          action.remote === undefined &&
          action.prevSync !== undefined &&
          action.local !== undefined &&
          (d?.includes("delete") || d?.includes("conflict"));
        if (looksRemoteDeleted) {
          action.decision = "equal"; // keep local + baseline; never delete
          suppressed++;
        }
      }
      if (suppressed > 0) {
        await errNotifyFunc(
          triggerSource,
          Error(
            `${undecryptableCount} remote ${undecryptableCount === 1 ? "entry" : "entries"} could not be decrypted; kept ${suppressed} local ${suppressed === 1 ? "file" : "files"} instead of deleting to prevent data loss. Check your password and encryption method.`
          )
        );
      }
    }

    // One-time upgrade safety net: the first encrypted sync after the
    // key-namespace fix runs without propagating remote-driven local deletions,
    // so any residual mismatch from a previously-broken baseline cannot
    // mass-delete local files. Intended deletions apply on the next sync.
    if (settings.password !== "" && !settings.encryptionFixSafetyDone) {
      let held = 0;
      for (const action of unsortedActions) {
        if (action.decision === "remote_is_deleted_thus_also_delete_local") {
          action.decision = "equal";
          held++;
        }
      }
      if (held > 0) {
        await errNotifyFunc(
          triggerSource,
          Error(
            `First encrypted sync after update: kept ${held} local ${held === 1 ? "file" : "files"} instead of deleting, as a one-time safety check. Re-run sync to apply any intended deletions.`
          )
        );
      }
    }

    // M1: Enforce folder-before-file creation order, file-before-folder delete order.
    let syncActions = sortSyncActions(unsortedActions);

    // M1.5: Rename Detection — converts delete+create pairs into single rename ops.
    // Must run AFTER sortSyncActions (which establishes the decision classification)
    // and BEFORE the protection check (renames are not destructive).
    const canRename = remoteFsTarget.supportsRename();
    syncActions = detectRenames(syncActions, canRename);

    // A remote that reports no files at all while sync history says it held
    // some is far more likely a misconfigured, changed, or brand-new remote
    // location than a genuine mass deletion. Planning local deletions from
    // that state would erase the vault, and the percentage threshold is the
    // only thing that would catch it, so refuse outright and explain (#11).
    // Deleting the last file or two of a tiny vault is indistinguishable from
    // that and legitimate, so only a sweep of three or more is refused; the
    // percentage threshold still covers the small cases.
    if (
      !remoteWalk.some((e) => !e.keyRaw.endsWith("/")) &&
      prevSyncItems.some((e) => !e.keyRaw.endsWith("/")) &&
      syncActions.filter(
        (a) => a.decision === "remote_is_deleted_thus_also_delete_local"
      ).length >= 3
    ) {
      throw Error(
        "Sync aborted: the remote returned no files, but this vault has sync history with it, so deleting the local copies is almost certainly wrong. If you changed the remote folder, endpoint, or account, point it back. If this new empty remote is intended, use Reset Local Internal Cache/Databases in the settings and sync again to upload everything fresh. No local files were changed."
      );
    }

    // M2: Protection — count operations that destroy or overwrite local content.
    // Rename decisions are explicitly skipped — a rename is a path change, not destruction.
    const allFileCount = nodes.size;
    
    if (allFileCount > 0) {
      // Counted separately so the log can say what was actually planned; the
      // threshold still applies to the total, because an overwrite-from-remote
      // destroys local content just as surely as a delete does.
      let deleteCount = 0;
      let overwriteCount = 0;
      for (const action of syncActions) {
        const d = action.decision;
        if (!d || d === "equal" || d === "only_history") continue;

        // Skip rename decisions — non-destructive path changes
        if (d === "rename_local_to_remote" || d === "rename_remote_to_local") continue;

        // Deletes (either side) are always destructive
        if (d.includes("delete")) {
          deleteCount++;
          continue;
        }

        // Pulls that OVERWRITE an existing local file
        if (d === "remote_is_modified_then_pull" && action.local !== undefined) {
          overwriteCount++;
          continue;
        }

        // Conflict resolutions that overwrite local with remote content
        if ((d.includes("keep_remote") || d.includes("smart_conflict")) && action.local !== undefined) {
          overwriteCount++;
          continue;
        }
      }
      const destructiveCount = deleteCount + overwriteCount;

      // Only consult the threshold when something destructive is actually
      // planned. A threshold of 0 means "always block", and without this guard a
      // no-op sync would abort too, since 0% is not below 0%.
      if (destructiveCount > 0) {
        const protectErr = getProtectError(
          settings.protectModifyPercentage ?? 50,
          destructiveCount,
          allFileCount
        );
        if (protectErr !== "") {
          const byDecision: Record<string, number> = {};
          for (const a of syncActions) {
            if (!a.decision || a.decision === "equal" || a.decision === "only_history") {
              continue;
            }
            byDecision[a.decision] = (byDecision[a.decision] ?? 0) + 1;
          }
          console.error(
            `[BYOC] Sync blocked by protection: ${deleteCount} deletion(s), ${overwriteCount} overwrite(s) of ${allFileCount} tracked items. Plan:`,
            byDecision
          );
          throw Error(`Protection Triggered: ${protectErr}`);
        }
      }
    }

    // Phase 3: Execution Engine
    await statusBarFunc(triggerSource, 7, true); // Exchanging data

    // A dry run stops at the plan. Returning here also skips the Phase 4
    // baseline commit and the one-time migration flag flips: persisting any
    // of those without executing the plan would corrupt the next real sync.
    if (triggerSource === "dry") {
      const byDecision: Record<string, number> = {};
      let totalPlanned = 0;
      for (const a of syncActions) {
        if (!a.decision || a.decision === "equal" || a.decision === "only_history") continue;
        byDecision[a.decision] = (byDecision[a.decision] ?? 0) + 1;
        totalPlanned++;
      }
      console.info("[BYOC] Dry run plan (nothing executed):", byDecision);
      await notifyFunc(triggerSource, 7); // "real sync is skipped in dry run mode"
      await dryRunSummaryFunc?.(byDecision, totalPlanned);
      await notifyFunc(triggerSource, 8);
      await statusBarFunc(triggerSource, 8, true);
      return;
    }

    const successfulCommits: Entity[] = [];
    let hadErrors = false;
    let counter = 0;

    for (const node of syncActions) {
      const decision = node.decision;
      if (decision === "equal" || decision === "only_history") {
        // A node forced to "equal" by the undecryptable-entry guard or the
        // upgrade safety net has no remote side. Merging the local entity there
        // would record the new local size/mtime against the old remote anchors,
        // a state that exists on neither side and then reads as "equal" forever,
        // silently losing the local edit. Keep the untouched baseline instead.
        // "only_history" means the file is gone from both sides, so its row is
        // dropped rather than carried forever.
        if (node.remote === undefined) {
          if (node.prevSync !== undefined && decision === "equal") {
            successfulCommits.push({ ...node.prevSync });
          }
          continue;
        }
        // Commit a complete baseline: local carries the plaintext key/mtime/size,
        // remote carries the server mtime + ciphertext size. Dropping the remote
        // anchors here makes the next sync misread the file as remotely changed
        // (server mtime vs local baseline, ciphertext size vs plaintext baseline).
        // Restate them after the spreads so ordering is not what keeps this right.
        const commitEntity: Entity = {
          ...node.prevSync,
          ...node.remote,
          ...node.local,
          mtimeSvr: node.remote.mtimeSvr ?? node.prevSync?.mtimeSvr,
          sizeEnc: node.remote.sizeEnc ?? node.prevSync?.sizeEnc,
        };
        successfulCommits.push(commitEntity);
        continue;
      }

      if (decision === "conflict_created_then_do_nothing") {
        // A one-way sync direction suppressed this operation, or the node's
        // local state could not be read. Carry the baseline row forward
        // untouched: merging either live side here would fabricate a state
        // that was never synced, and dropping the row would re-plan the same
        // suppressed operation on every following sync.
        if (node.prevSync !== undefined) {
          successfulCommits.push({ ...node.prevSync });
        }
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
            // The remote is authoritative for the remote anchors, and node.remote
            // describes the NEW path while prevSync describes the old one.
            mtimeSvr: node.remote?.mtimeSvr ?? node.prevSync?.mtimeSvr,
            sizeRaw: freshEntity.sizeRaw,
            sizeEnc:
              node.prevSync?.sizeEnc ??
              node.remote?.sizeEnc ??
              node.remote?.sizeRaw,
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

    // Mark the one-time encryption-fix safety net as satisfied after a clean run.
    if (settings.password !== "" && !settings.encryptionFixSafetyDone) {
      settings.encryptionFixSafetyDone = true;
      await configSaver();
    }

    // Mark the one-time baseline re-anchor as done, but only after a clean run
    // that actually persisted a baseline. Deliberately outside the password
    // guard above: the stale anchor affects encrypted and plain vaults alike.
    if (!hadErrors && !settings.svrAnchorFixDone) {
      settings.svrAnchorFixDone = true;
      await configSaver();
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
