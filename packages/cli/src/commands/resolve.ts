import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ConfigStore } from "../store/config.js";
import { withProjectStorage } from "../store/project-storage.js";
import {
  applyConflictPolicy,
  detectMarkers,
  resolveMarker,
  hasUnresolvedMarkers,
  type PolicyResolution,
} from "../sync/conflict-marker.js";
import { extractSyncFields, hashSyncFields, hashTask } from "../sync/hash.js";
import { formatConflictList, buildConflictJson } from "./conflicts.js";
import { formatValue } from "../util/format.js";
import type { ConflictPolicy, SyncFieldKey, SyncFields, Task } from "@gh-gantt/shared";

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

/** 宣言的ポリシーを issue / field filter 後に適用する純粋関数。 */
export function resolveAllByPolicy(
  tasks: Record<string, unknown>[],
  policy: ConflictPolicy,
  filterIssue?: number,
  filterField?: string,
): Map<string, PolicyResolution> {
  const resolutions = new Map<string, PolicyResolution>();
  for (const task of tasks) {
    const id = task.id as string;
    if (filterIssue !== undefined && extractIssueNumber(id) !== filterIssue) continue;
    if (detectMarkers(task).length === 0) continue;
    resolutions.set(id, applyConflictPolicy(task, policy, filterField));
  }
  return resolutions;
}

/**
 * theirs で解決したフィールドだけ snapshot baseline をリモート値へ進める。
 * ours とコンフリクト外の local-only 差分は旧 baseline に残し、後続 push で検出する。
 */
function advanceSnapshotBaseline(
  existing: SyncFields | undefined,
  resolved: SyncFields,
  theirsFields: ReadonlySet<string>,
): SyncFields | undefined {
  if (!existing) return undefined;
  const next = { ...existing };
  for (const field of theirsFields) {
    (next as unknown as Record<string, unknown>)[field] = resolved[field as SyncFieldKey];
  }
  return next;
}

interface ResolveCommandDependencies {
  projectRoot?: () => string;
}

interface ResolveOptions {
  ours?: boolean;
  theirs?: boolean;
  auto?: boolean;
  field?: string;
  json?: boolean;
}

export function createResolveCommand(dependencies: ResolveCommandDependencies = {}): Command {
  return new Command("resolve")
    .description("Resolve sync conflicts")
    .argument("[issue]", "Filter by issue number", parseInt)
    .option("--ours", "Resolve all conflicts with local values")
    .option("--theirs", "Resolve all conflicts with remote values")
    .option("--auto", "Resolve conflicts using sync.conflict_policy")
    .option("--field <field>", "Resolve only specific field")
    .option("--json", "Output remaining conflicts as JSON (batch mode only)")
    .action(async (issue?: number, opts?: ResolveOptions) => {
      const selectedModes = [opts?.ours, opts?.theirs, opts?.auto].filter(Boolean).length;
      if (selectedModes > 1) {
        throw new Error("--auto / --ours / --theirs は排他的なオプションです");
      }

      const projectRoot = dependencies.projectRoot?.() ?? process.cwd();
      return withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { tasksStore, stateStore } = storage;
          const tasksFile = await tasksStore.read();
          const syncState = await stateStore.read();

          const tasks = tasksFile.tasks as unknown as Record<string, unknown>[];

          const theirsResolutionFields = new Map<string, Set<string>>();
          const snapshotTargetTaskIds = new Set<string>();

          // 開始時に marker を持ち、Issue filter に一致する task だけを更新対象として固定する。
          for (const task of tasks) {
            const id = task.id as string;
            const markers = detectMarkers(task);
            const matchesIssue = issue === undefined || extractIssueNumber(id) === issue;
            if (markers.length > 0 && matchesIssue) {
              snapshotTargetTaskIds.add(id);
            }
          }

          if (opts?.auto) {
            const config = await new ConfigStore(projectRoot).read();
            const legacyStrategy = (config.sync as unknown as Record<string, unknown>)[
              "conflict_strategy"
            ];
            if (legacyStrategy !== undefined) {
              console.warn(
                "WARNING: sync.conflict_strategy は deprecated であり resolve --auto では無視されます。sync.conflict_policy にフィールド単位の ours / theirs / manual を設定してください。",
              );
            }
            const policyResolutions = resolveAllByPolicy(
              tasks,
              config.sync.conflict_policy ?? {},
              issue,
              opts.field,
            );
            for (const [id, resolution] of policyResolutions) {
              theirsResolutionFields.set(id, resolution.theirs);
            }
          } else if (opts?.ours || opts?.theirs) {
            // Batch mode
            const choice = opts.ours ? "ours" : "theirs";
            const batchResolutions = resolveAll(tasks, choice, issue, opts.field);

            // snapshot baseline を進める theirs フィールドを記録する
            for (const [id, fields] of batchResolutions) {
              theirsResolutionFields.set(id, fields);
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
                    const fields = theirsResolutionFields.get(id) ?? new Set<string>();
                    fields.add(marker.field);
                    theirsResolutionFields.set(id, fields);
                  }
                }
              }
            } finally {
              rl.close();
            }
          }

          // Update snapshots for fully resolved tasks
          for (const task of tasks) {
            const id = task.id as string;
            if (!snapshotTargetTaskIds.has(id)) continue;
            if (hasUnresolvedMarkers(task)) continue;

            // Skip draft tasks (no issue number)
            if (!id.includes("#")) continue;

            try {
              const existing = syncState.snapshots[id];
              if (!existing) continue;

              const taskTyped = task as unknown as Task;
              const resolvedTaskSyncFields = extractSyncFields(taskTyped);
              const resolvedTaskHash = hashTask(taskTyped);

              if (existing.remoteHash && resolvedTaskHash === existing.remoteHash) {
                // task 全体が remote と一致するときだけ snapshot 全体を remote へ進める。
                syncState.snapshots[id] = {
                  ...existing,
                  hash: existing.remoteHash,
                  syncFields: resolvedTaskSyncFields,
                };
                continue;
              }

              const conservativeSyncFields = advanceSnapshotBaseline(
                existing.syncFields,
                resolvedTaskSyncFields,
                theirsResolutionFields.get(id) ?? new Set(),
              );
              if (conservativeSyncFields) {
                // baseline を進める場合は hash と syncFields を必ず同じ内容に揃える。
                syncState.snapshots[id] = {
                  ...existing,
                  hash: hashSyncFields(conservativeSyncFields),
                  syncFields: conservativeSyncFields,
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
          await storage.flush();

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
    });
}

export const resolveCommand = createResolveCommand();
