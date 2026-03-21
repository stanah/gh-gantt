/**
 * Pure merge logic for pull operations.
 * Extracted from pull command to enable E2E testing without GitHub API.
 */
import type { Task, SyncState, SyncFields } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "./hash.js";
import { threeWayMerge, type FieldConflict } from "./three-way-merge.js";
import { applyConflictMarkers } from "./conflict-marker.js";
import { isDraftTask } from "../github/issues.js";

export interface PullMergeInput {
  localTasks: Task[];
  remoteTasks: Task[];
  syncState: SyncState;
}

export interface PullMergeResult {
  tasks: Task[];
  snapshots: SyncState["snapshots"];
  hasConflicts: boolean;
  added: number;
  updated: number;
  removed: number;
  conflictCount: number;
  warnings: string[];
}

export function executePullMerge(input: PullMergeInput): PullMergeResult {
  const { localTasks, remoteTasks, syncState } = input;

  const remoteMap = new Map(remoteTasks.map((t) => [t.id, t]));
  const localTaskMap = new Map(localTasks.map((t) => [t.id, t]));

  let added = 0;
  let updated = 0;
  let removed = 0;
  let conflictCount = 0;
  let hasConflicts = false;
  const warnings: string[] = [];

  const mergedTasks: Task[] = [];

  // Process remote tasks — 3-way merge
  for (const [id, remoteTask] of remoteMap) {
    const localTask = localTaskMap.get(id);
    if (!localTask) {
      // New task from remote
      mergedTasks.push(remoteTask);
      added++;
    } else {
      const snapshot = syncState.snapshots[id];
      const remoteHash = hashTask(remoteTask);
      const snapshotRemoteHash = snapshot?.remoteHash ?? snapshot?.hash;

      if (remoteHash === snapshotRemoteHash) {
        // Remote unchanged since last sync → keep local
        mergedTasks.push(localTask);
      } else if (!snapshot || !snapshot.syncFields) {
        // No snapshot or no syncFields → fall back to remote
        mergedTasks.push(remoteTask);
        updated++;
      } else {
        // 3-way merge
        const localFields = extractSyncFields(localTask);
        const remoteFields = extractSyncFields(remoteTask);
        const { merged, conflicts } = threeWayMerge(snapshot.syncFields, localFields, remoteFields);

        const mergedTask: Task = { ...localTask, ...merged };
        // Always update read-only fields from remote
        mergedTask.created_at = remoteTask.created_at;
        mergedTask.updated_at = remoteTask.updated_at;
        mergedTask.closed_at = remoteTask.closed_at;
        mergedTask.state_reason = remoteTask.state_reason;
        mergedTask.linked_prs = remoteTask.linked_prs;

        if (conflicts.length > 0) {
          const marked = applyConflictMarkers(mergedTask, conflicts);
          mergedTasks.push(marked as unknown as Task);
          hasConflicts = true;
          conflictCount++;
        } else {
          mergedTasks.push(mergedTask);
          const localHash = hashTask(localTask);
          const mergedHash = hashTask(mergedTask);
          if (localHash !== mergedHash) {
            updated++;
          }
        }
      }
      localTaskMap.delete(id);
    }
  }

  // Tasks that exist locally but not remotely
  for (const [id, localTask] of localTaskMap) {
    if (isDraftTask(id)) {
      mergedTasks.push(localTask);
      continue;
    }
    const snapshot = syncState.snapshots[id];
    if (snapshot) {
      const localHash = hashTask(localTask);
      if (localHash !== snapshot.hash) {
        warnings.push(`${id}: ${localTask.title} (locally modified but removed from remote — keeping)`);
        mergedTasks.push(localTask);
        continue;
      }
    }
    removed++;
  }

  // Update snapshots
  const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
  for (const task of mergedTasks) {
    const remoteTask = remoteMap.get(task.id);
    const remoteHash = remoteTask ? hashTask(remoteTask) : undefined;
    const existing = syncState.snapshots[task.id];

    const isConflicted = hasConflicts && remoteTask && existing?.syncFields && (() => {
      const localFields = extractSyncFields(task);
      const remoteFields = extractSyncFields(remoteTask);
      const { conflicts } = threeWayMerge(existing.syncFields!, localFields, remoteFields);
      return conflicts.length > 0;
    })();

    const hasLocalChanges = existing && hashTask(task) !== existing.hash;

    if (isConflicted || hasLocalChanges) {
      // Preserve snapshot hash so local changes remain pushable
      newSnapshots[task.id] = {
        ...(existing ?? { hash: hashTask(task), synced_at: new Date().toISOString() }),
        remoteHash,
      };
    } else if (existing && remoteHash === (existing.remoteHash ?? existing.hash)) {
      newSnapshots[task.id] = { ...existing, remoteHash };
    } else {
      newSnapshots[task.id] = {
        hash: hashTask(task),
        synced_at: new Date().toISOString(),
        updated_at: task.updated_at,
        syncFields: extractSyncFields(task),
        remoteHash,
      };
    }
  }
  // Remove snapshots for deleted tasks
  for (const id of localTaskMap.keys()) {
    delete newSnapshots[id];
  }

  return {
    tasks: mergedTasks,
    snapshots: newSnapshots,
    hasConflicts,
    added,
    updated,
    removed,
    conflictCount,
    warnings,
  };
}
