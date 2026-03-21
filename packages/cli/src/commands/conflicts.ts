import { Command } from "commander";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { detectMarkers } from "../sync/conflict-marker.js";
import type { SyncState } from "@gh-gantt/shared";

/**
 * Extract issue number from task id (e.g. "owner/repo#8" -> 8).
 */
function extractIssueNumber(id: string): number | undefined {
  const match = id.match(/#(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Format a value for display.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
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

export const conflictsCommand = new Command("conflicts")
  .description("Show unresolved sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .action(async (issue?: number) => {
    const projectRoot = process.cwd();
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    const tasks = tasksFile.tasks as unknown as Record<string, unknown>[];
    const output = formatConflictList(tasks, syncState.snapshots, issue);
    console.log(output);
  });
