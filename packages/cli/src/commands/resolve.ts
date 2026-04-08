import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { detectMarkers, resolveMarker, hasUnresolvedMarkers } from "../sync/conflict-marker.js";
import { extractSyncFields } from "../sync/hash.js";
import { formatConflictList, buildConflictJson } from "./conflicts.js";
import { formatValue } from "../util/format.js";
import type { Task } from "@gh-gantt/shared";

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
 * Returns a map of task id -> set of fields resolved with "theirs".
 */
export function resolveAll(
  tasks: Record<string, unknown>[],
  choice: "ours" | "theirs",
  filterIssue?: number,
  filterField?: string,
): Map<string, Set<string>> {
  const theirsResolutions = new Map<string, Set<string>>();

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

      // Track fields resolved with "theirs"
      if (choice === "theirs") {
        if (!theirsResolutions.has(id)) {
          theirsResolutions.set(id, new Set());
        }
        theirsResolutions.get(id)!.add(marker.field);
      }
    }
  }

  return theirsResolutions;
}

export const resolveCommand = new Command("resolve")
  .description("Resolve sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .option("--ours", "Resolve all conflicts with local values")
  .option("--theirs", "Resolve all conflicts with remote values")
  .option("--field <field>", "Resolve only specific field")
  .option("--json", "Output remaining conflicts as JSON (batch mode only)")
  .action(
    async (
      issue?: number,
      opts?: { ours?: boolean; theirs?: boolean; field?: string; json?: boolean },
    ) => {
      const projectRoot = process.cwd();
      const tasksStore = new TasksStore(projectRoot);
      const stateStore = new SyncStateStore(projectRoot);

      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      const tasks = tasksFile.tasks as unknown as Record<string, unknown>[];

      // Track conflict resolution choices for each task
      // Map: task id -> { totalConflicts: number, theirsCount: number }
      const resolutionStats = new Map<string, { totalConflicts: number; theirsCount: number }>();

      // Count initial conflicts for each task
      for (const task of tasks) {
        const id = task.id as string;
        const markers = detectMarkers(task);
        if (markers.length > 0) {
          resolutionStats.set(id, { totalConflicts: markers.length, theirsCount: 0 });
        }
      }

      if (opts?.ours || opts?.theirs) {
        // Batch mode
        const choice = opts.ours ? "ours" : "theirs";
        const batchResolutions = resolveAll(tasks, choice, issue, opts.field);

        // Update theirsCount based on resolutions
        for (const [id, fields] of batchResolutions) {
          const stats = resolutionStats.get(id);
          if (stats) {
            stats.theirsCount = fields.size;
          }
        }
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

              // Track fields resolved with "theirs"
              if (choice === "theirs") {
                const stats = resolutionStats.get(id);
                if (stats) {
                  stats.theirsCount++;
                }
              }
            }
          }
        } finally {
          rl.close();
        }
      }

      // Update snapshots for fully resolved tasks
      for (const task of tasks) {
        if (hasUnresolvedMarkers(task)) continue;

        const id = task.id as string;
        // Skip draft tasks (no issue number)
        if (!id.includes("#")) continue;

        try {
          const existing = syncState.snapshots[id];
          if (!existing) continue;

          const taskTyped = task as unknown as Task;
          const stats = resolutionStats.get(id);

          // すべてのコンフリクトが --theirs で解決された場合のみ、
          // snapshot.hash をリモート値に揃える
          // これによりタスクがリモートと同一状態になり、status/push で検出されなくなる
          const allResolvedWithTheirs =
            stats && stats.theirsCount > 0 && stats.theirsCount === stats.totalConflicts;

          if (allResolvedWithTheirs && existing.remoteHash) {
            // remoteHash をそのまま使用してタスクをリモートと同一状態にする
            syncState.snapshots[id] = {
              ...existing,
              hash: existing.remoteHash,
              syncFields: extractSyncFields(taskTyped),
            };
          } else {
            // --ours で解決された場合、または一部のみ --theirs で解決された場合は、
            // hash を更新しない（ローカル変更として push 可能にするため）
            syncState.snapshots[id] = {
              ...existing,
              syncFields: extractSyncFields(taskTyped),
            };
          }
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
      if (opts?.json) {
        const json = buildConflictJson(tasks, syncState.snapshots, issue);
        console.log(JSON.stringify(json, null, 2));
      } else {
        const remaining = formatConflictList(tasks, syncState.snapshots, issue);
        console.log(remaining);
      }
    },
  );
