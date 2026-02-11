import type { Task, SyncState, SyncFields } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "./hash.js";
import { isDraftTask, isMilestoneDraftTask, isMilestoneSyntheticTask } from "../github/issues.js";

export interface TaskDiff {
  id: string;
  type: "added" | "modified" | "deleted";
  task: Task;
  changedFields?: string[];
}

export function detectChangedFields(current: SyncFields, previous: SyncFields): string[] {
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

export function estimateApiCalls(diffs: TaskDiff[], options?: { autoCreateIssues?: boolean }): number {
  const autoCreate = options?.autoCreateIssues ?? true;
  let calls = 0;
  for (const diff of diffs) {
    if (diff.type === "deleted") continue;
    if (isDraftTask(diff.id)) {
      if (isMilestoneDraftTask(diff.task)) {
        // createGithubMilestone via REST
        calls += 1;
      } else if (autoCreate) {
        // createIssue + addProjectItem + up to 4 field updates
        calls += 6;
      }
    } else if (diff.type === "modified") {
      // updateIssue + setState + up to 3 field updates
      calls += 5;
    }
  }
  return calls;
}

export interface DiffPreviewChange {
  id: string;
  title: string;
  type: "added" | "modified";
  changedFields?: string[];
}

export interface DiffPreview {
  preview: true;
  summary: { create: number; update: number; skip: number };
  estimated_api_calls: number;
  changes: DiffPreviewChange[];
}

export function formatDiffPreview(diffs: TaskDiff[], options?: { autoCreateIssues?: boolean }): DiffPreview {
  const pushable = diffs.filter((d) => !isMilestoneSyntheticTask(d.id));
  const autoCreate = options?.autoCreateIssues ?? true;

  let create = 0;
  let update = 0;
  let skip = 0;
  const changes: DiffPreviewChange[] = [];

  for (const diff of pushable) {
    if (diff.type === "deleted") {
      skip++;
      continue;
    }
    if (isDraftTask(diff.id)) {
      if (autoCreate || isMilestoneDraftTask(diff.task)) {
        create++;
        changes.push({
          id: diff.id,
          title: diff.task.title,
          type: "added",
          changedFields: diff.changedFields,
        });
      } else {
        skip++;
      }
    } else if (diff.type === "modified") {
      update++;
      changes.push({
        id: diff.id,
        title: diff.task.title,
        type: "modified",
        changedFields: diff.changedFields,
      });
    }
  }

  return {
    preview: true,
    summary: { create, update, skip },
    estimated_api_calls: estimateApiCalls(pushable, options),
    changes,
  };
}
