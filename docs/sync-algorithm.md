# BYOC Sync Algorithm Specification

**Version:** 1.0.0 (Clean-Room Implementation)
**Architecture:** 3-Way Merge (Local vs. Remote, anchored by Previous State)

## Core Philosophy
The Bring Your Own Cloud (BYOC) synchronization engine operates on an event-driven, 3-way merge model. It replaces the proprietary `remotely-save` module.

The engine must determine the correct action (Push, Pull, Delete, Skip, Conflict Resolution) for every file by comparing current file metadata against a local IndexedDB cache (`prevSyncRecords`), which represents the exact state of the file at the conclusion of the *last successful sync*. 

This guarantees safe, bidirectional true-sync semantics without blindly overwriting files based on remote timestamps.

---

## The Synchronization Phases

The synchronization pipeline executes linearly through the following phases.

### Phase 1: Fetch State & Discovery (`fsLocal.walk()` + `fsRemote.walk()`)
The `syncer` orchestrator invokes a deep tree walk on both `fsLocal` and `fsRemote`.
- Retrieves arrays of `Entity` objects containing `{ key, mtime, size, isDir }` for all local and remote files.
- Deserializes the previous successful baseline state from `InternalDBs.prevSyncRecordsTbl`.

### Phase 2: Matrix Assembly & Planning (`planner.ts`)
The `planner` constructs a master hash map resolving every unique file path (`key`) to a `DiffNode`:
```typescript
interface DiffNode {
  key: string;
  local?: Entity;     // Current Local State
  remote?: Entity;    // Current Remote State
  baseline?: Entity;  // Last known synced state
}
```

The Planner loops through the array of `DiffNode` and assigns an initial sync intention based strictly on state truth tables:

#### 1. Additions
- **Local Exists, Remote Missing, Baseline Missing:** `Push` (Upload new local file).
- **Remote Exists, Local Missing, Baseline Missing:** `Pull` (Download new remote file).

#### 2. Modifications (Mutations)
- **Local `mtime` > Baseline, Remote == Baseline:** `Push` (Local edited, Remote untouched).
- **Remote `mtime` > Baseline, Local == Baseline:** `Pull` (Remote edited, Local untouched).
- **Local `mtime` > Baseline AND Remote `mtime` > Baseline:** `Conflict` (Both edited).

#### 3. Deletions (Tombstones)
- **Local Missing, Baseline Exists, Remote == Baseline:** `Delete Remote` (File was deleted locally; propagate deletion).
- **Remote Missing, Baseline Exists, Local == Baseline:** `Delete Local` (File was deleted remotely; propagate deletion).

### Phase 3: Conflict Resolution (`conflict.ts`)
If a `DiffNode` is flagged as `Conflict`, the engine consults user preferences (`settings.conflictAction`):
- **keep_newer**: Evaluates `Math.max(local.mtime, remote.mtime)`. The winner drives the state (Push/Pull).
- **keep_local**: Forces a `Push`.
- **keep_remote**: Forces a `Pull`.
- **keep_both**: Appends a suffix (e.g., `.conflict.md`) to the local file, triggering an upload on the next pass without destroying data.

### Phase 4: Execution Engine (`syncer.ts`)
The execution engine groups the resolved `ActionPlan` into queues (Deletions first, Additions/Modifications next).
It implements bounded concurrency using `promise.all` limits based on the user's `settings.concurrency` configuration.

**Operations:**
- **Push:** Maps to `fsRemote.writeFile(fsLocal.readFile())`.
- **Pull:** Maps to `fsLocal.writeFile(fsRemote.readFile())`.
- **Delete Local:** Maps to `fsLocal.rm()`.
- **Delete Remote:** Maps to `fsRemote.rm()`.

### Phase 5: Committing the Baseline State
Crucially, when the Execution phase finishes, **only files that successfully synced** correctly update their footprint in the `prevSyncRecordsTbl`.
1. The old cache is purged or updated iteratively.
2. The exact Remote `mtime` and Local `mtime` are stored. 
3. If the network drops at 99%, the next sync resumes perfectly because the un-pushed files failed to register a new baseline.

---

## Defensive Checks and Safety Constraints
- **Empty File Protection:** If an `Entity` reports a byte size of `0`, the planner flags it. Depending on `settings.emptyFile`, it will either `skip` (standard for syncing configurations) or attempt to `pull/push`.
- **Size Limits:** Honors `settings.skipSizeLargerThan`. Files exceeding this byte boundary are perpetually excluded from the matrix assembly.
- **Dry Run Compatibility:** The planner strictly isolates the *decision state* from the *execution state*, allowing for accurate Dry Run outputs without executing writes.
