import type { Task, SyncState } from "@gh-gantt/shared";
import { hashTask } from "./hash.js";

export interface TaskDiff {
  id: string;
  type: "added" | "modified" | "deleted";
  task: Task;
  changedFields?: string[];
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
      diffs.push({ id: task.id, type: "modified", task });
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
