import type { Task, SyncState, SyncFields } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "./hash.js";

export interface TaskDiff {
  id: string;
  type: "added" | "modified" | "deleted";
  task: Task;
  changedFields?: string[];
}

function detectChangedFields(current: SyncFields, previous: SyncFields): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(current) as (keyof SyncFields)[]) {
    const a = JSON.stringify(current[key]);
    const b = JSON.stringify(previous[key]);
    if (a !== b) {
      changed.push(key);
    }
  }
  return changed;
}

export function computeLocalDiff(
  tasks: Task[],
  syncState: SyncState,
): TaskDiff[] {
  const diffs: TaskDiff[] = [];

  for (const task of tasks) {
    const snapshot = syncState.snapshots[task.id];
    if (!snapshot) {
      diffs.push({ id: task.id, type: "added", task });
      continue;
    }

    const currentHash = hashTask(task);
    if (currentHash !== snapshot.hash) {
      const changedFields = snapshot.syncFields
        ? detectChangedFields(extractSyncFields(task), snapshot.syncFields)
        : undefined;
      diffs.push({ id: task.id, type: "modified", task, changedFields });
    }
  }

  // Detect deleted tasks (in snapshots but not in tasks)
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const id of Object.keys(syncState.snapshots)) {
    if (!taskIds.has(id)) {
      diffs.push({
        id,
        type: "deleted",
        task: { id } as Task, // Minimal placeholder
      });
    }
  }

  return diffs;
}
