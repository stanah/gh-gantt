import { Command } from "commander";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { detectMarkers } from "../sync/conflict-marker.js";
import { formatValue } from "../util/format.js";
import type { SyncState } from "@gh-gantt/shared";

/**
 * Extract issue number from task id (e.g. "owner/repo#8" -> 8).
 */
function extractIssueNumber(id: string): number | undefined {
  const match = id.match(/#(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Pure function for testability.
 * Formats a list of conflicts found in tasks, enriched with base values from snapshots.
 */
export function formatConflictList(
  tasks: Record<string, unknown>[],
  snapshots: SyncState["snapshots"],
  filterIssue?: number,
): string {
  let taskCount = 0;
  let conflictCount = 0;
  const lines: string[] = [];

  for (const task of tasks) {
    const id = task.id as string;

    // Filter by issue number if specified
    if (filterIssue !== undefined) {
      const issueNum = extractIssueNumber(id);
      if (issueNum !== filterIssue) continue;
    }

    const markers = detectMarkers(task);
    if (markers.length === 0) continue;

    taskCount++;
    conflictCount += markers.length;

    const title = task.title as string;
    const issueNum = extractIssueNumber(id);
    lines.push(`  #${issueNum}: ${title}`);

    const snapshot = snapshots[id];
    const syncFields = snapshot?.syncFields as Record<string, unknown> | undefined;

    for (const marker of markers) {
      const base = syncFields ? syncFields[marker.field] : undefined;
      lines.push(
        `    ${marker.field}: current=${formatValue(marker.current)}  incoming=${formatValue(marker.incoming)}  base=${formatValue(base)}`,
      );
    }
  }

  if (taskCount === 0) {
    return "No conflicts.";
  }

  lines.push(`${taskCount} task(s), ${conflictCount} conflict(s)`);
  return lines.join("\n");
}

export interface ConflictJson {
  tasks: Array<{
    id: string;
    title: string;
    issue: number | null;
    conflicts: Array<{
      field: string;
      current: unknown;
      incoming: unknown;
      base: unknown;
    }>;
  }>;
  task_count: number;
  conflict_count: number;
}

/**
 * Pure function for testability.
 * Builds a JSON-serializable conflict report.
 */
export function buildConflictJson(
  tasks: Record<string, unknown>[],
  snapshots: SyncState["snapshots"],
  filterIssue?: number,
): ConflictJson {
  const result: ConflictJson = { tasks: [], task_count: 0, conflict_count: 0 };

  for (const task of tasks) {
    const id = task.id as string;

    if (filterIssue !== undefined) {
      const issueNum = extractIssueNumber(id);
      if (issueNum !== filterIssue) continue;
    }

    const markers = detectMarkers(task);
    if (markers.length === 0) continue;

    const snapshot = snapshots[id];
    const syncFields = snapshot?.syncFields as Record<string, unknown> | undefined;

    result.task_count++;
    result.conflict_count += markers.length;

    result.tasks.push({
      id,
      title: task.title as string,
      issue: extractIssueNumber(id) ?? null,
      conflicts: markers.map((marker) => ({
        field: marker.field,
        current: marker.current,
        incoming: marker.incoming,
        base: syncFields ? (syncFields[marker.field] ?? null) : null,
      })),
    });
  }

  return result;
}

export const conflictsCommand = new Command("conflicts")
  .description("Show unresolved sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .option("--json", "Output as JSON")
  .action(async (issue?: number, opts?: { json?: boolean }) => {
    const projectRoot = process.cwd();
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    const tasks = tasksFile.tasks as unknown as Record<string, unknown>[];

    if (opts?.json) {
      const json = buildConflictJson(tasks, syncState.snapshots, issue);
      console.log(JSON.stringify(json, null, 2));
    } else {
      const output = formatConflictList(tasks, syncState.snapshots, issue);
      console.log(output);
    }
  });
