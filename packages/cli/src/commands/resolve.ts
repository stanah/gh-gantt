import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import {
  detectMarkers,
  resolveMarker,
  hasUnresolvedMarkers,
} from "../sync/conflict-marker.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import { formatConflictList } from "./conflicts.js";
import type { Task, SyncState } from "@gh-gantt/shared";

/**
 * Extract issue number from task id (e.g. "owner/repo#8" -> 8).
 */
function extractIssueNumber(id: string): number | undefined {
  const match = id.match(/#(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Pure function for testability.
 * Resolves conflict markers in tasks.
 * Mutates the tasks array in place.
 */
export function resolveAll(
  tasks: Record<string, unknown>[],
  choice: "ours" | "theirs",
  filterIssue?: number,
  filterField?: string,
): void {
  for (const task of tasks) {
    const id = task.id as string;

    // Filter by issue number if specified
    if (filterIssue !== undefined) {
      const issueNum = extractIssueNumber(id);
      if (issueNum !== filterIssue) continue;
    }

    const markers = detectMarkers(task);
    if (markers.length === 0) continue;

    for (const marker of markers) {
      // Filter by field if specified
      if (filterField !== undefined && marker.field !== filterField) continue;
      resolveMarker(task, marker.field, choice);
    }
  }
}

export const resolveCommand = new Command("resolve")
  .description("Resolve sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .option("--ours", "Resolve all conflicts with local values")
  .option("--theirs", "Resolve all conflicts with remote values")
  .option("--field <field>", "Resolve only specific field")
  .action(async (issue?: number, opts?: { ours?: boolean; theirs?: boolean; field?: string }) => {
    const projectRoot = process.cwd();
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    const tasks = tasksFile.tasks as unknown as Record<string, unknown>[];

    if (opts?.ours || opts?.theirs) {
      // Batch mode
      const choice = opts.ours ? "ours" : "theirs";
      resolveAll(tasks, choice, issue, opts.field);
    } else {
      // Interactive mode
      const rl = readline.createInterface({ input, output });

      try {
        for (const task of tasks) {
          const id = task.id as string;

          if (issue !== undefined) {
            const issueNum = extractIssueNumber(id);
            if (issueNum !== issue) continue;
          }

          const markers = detectMarkers(task);
          if (markers.length === 0) continue;

          const title = task.title as string;
          const issueNum = extractIssueNumber(id);
          console.log(`\n#${issueNum}: ${title}`);

          for (const marker of markers) {
            if (opts?.field !== undefined && marker.field !== opts.field) continue;

            console.log(`  ${marker.field}:`);
            console.log(`    [o]urs   = ${formatValue(marker.current)}`);
            console.log(`    [t]heirs = ${formatValue(marker.incoming)}`);

            let answer = "";
            while (answer !== "o" && answer !== "t") {
              answer = (await rl.question("  Choose [o/t]: ")).trim().toLowerCase();
            }

            const choice = answer === "o" ? "ours" : "theirs";
            resolveMarker(task, marker.field, choice);
          }
        }
      } finally {
        rl.close();
      }
    }

    // Update has_conflicts flag on each task
    for (const task of tasks) {
      if (hasUnresolvedMarkers(task)) {
        task.has_conflicts = true;
      } else {
        delete task.has_conflicts;
      }
    }

    // Update snapshots for fully resolved tasks
    for (const task of tasks) {
      if (hasUnresolvedMarkers(task)) continue;

      const id = task.id as string;
      // Skip draft tasks (no issue number)
      if (!id.includes("#")) continue;

      try {
        const taskTyped = task as unknown as Task;
        const hash = hashTask(taskTyped);
        const syncFields = extractSyncFields(taskTyped);

        syncState.snapshots[id] = {
          hash,
          synced_at: new Date().toISOString(),
          syncFields,
        };
      } catch {
        // If task can't be hashed (e.g. missing fields after conflict resolution),
        // skip snapshot update
      }
    }

    // Update global has_conflicts flag
    const anyConflicts = tasks.some((t) => hasUnresolvedMarkers(t));
    if (anyConflicts) {
      (tasksFile as unknown as Record<string, unknown>).has_conflicts = true;
    } else {
      delete (tasksFile as unknown as Record<string, unknown>).has_conflicts;
    }

    await tasksStore.write(tasksFile);
    await stateStore.write(syncState);

    // Print remaining conflicts or success
    const remaining = formatConflictList(tasks, syncState.snapshots, issue);
    console.log(remaining);
  });

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}
