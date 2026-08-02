import { Command } from "commander";
import { withProjectStorage } from "../../store/project-storage.js";
import { resolveTaskId } from "../../util/task-id.js";
import { executeWriteThroughPush } from "./write-through-push.js";
import type { Config, Task } from "@gh-gantt/shared";
import { normalizeAcceptanceCriteria } from "@gh-gantt/shared";
import { WorkGraphCommandEngine } from "../../work-graph/command-engine.js";

export interface TaskUpdateOptions {
  title?: string;
  body?: string;
  type?: string;
  state?: "open" | "closed";
  status?: string;
  priority?: string;
  startDate?: string;
  endDate?: string;
  assignee?: string;
  removeAssignee?: string;
  assignImplementer?: string;
  assignReviewer?: string;
  requireReview?: boolean;
  approveReview?: string;
  clearReviewApproval?: boolean;
  evidence?: string;
  milestone?: string;
  label?: string;
  removeLabel?: string;
}

export function applyTaskUpdate(
  task: Task,
  opts: TaskUpdateOptions,
  config: Config,
): { task: Task; error?: string } {
  const projected = new WorkGraphCommandEngine(config).projectTaskUpdate(task, opts);
  return projected.ok ? { task: projected.task } : { task, error: projected.error };
}
function isSameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a == null && b == null;
  return a.toLowerCase() === b.toLowerCase();
}

export function isReviewRequired(task: Task, config: Config): boolean {
  return (
    task.require_review === true ||
    (config.require_review_for_types ?? []).some((type) => type === task.type)
  );
}

export function validateTaskCloseReview(task: Task, config: Config): string | undefined {
  if (!isReviewRequired(task, config)) {
    return undefined;
  }
  if (!task.reviewer) {
    return "Review is required before closing. Assign a reviewer first.";
  }
  if (!task.review_approved_by) {
    return `Review is required before closing. Approve with --approve-review ${task.reviewer}.`;
  }
  if (!isSameLogin(task.review_approved_by, task.reviewer)) {
    return `Review must be approved by assigned reviewer "${task.reviewer}".`;
  }
  return undefined;
}

export function validateTaskCloseAcceptanceCriteria(task: Task): string | undefined {
  const unchecked = normalizeAcceptanceCriteria(task.acceptance_criteria).filter(
    (criterion) => !criterion.checked,
  );
  if (unchecked.length === 0) {
    return undefined;
  }
  return `Acceptance criteria must be checked before closing: ${unchecked
    .map((criterion) => criterion.description)
    .join(", ")}`;
}

export interface BulkFilterOptions {
  filterState?: string;
  filterType?: string;
  filterMilestone?: string;
  filterLabel?: string;
}

export function filterTasksForUpdate(tasks: Task[], filters: BulkFilterOptions): Task[] {
  let result = tasks;

  if (filters.filterState) {
    result = result.filter((t) => t.state === filters.filterState);
  }
  if (filters.filterType) {
    result = result.filter((t) => t.type === filters.filterType);
  }
  if (filters.filterMilestone) {
    if (filters.filterMilestone === "none") {
      result = result.filter((t) => t.milestone === null);
    } else {
      result = result.filter((t) => t.milestone === filters.filterMilestone);
    }
  }
  if (filters.filterLabel) {
    result = result.filter((t) => t.labels.includes(filters.filterLabel!));
  }

  return result;
}

export function createTaskUpdateCommand(): Command {
  return new Command("update")
    .description("Update a task (single or bulk)")
    .argument("[id]", "Task ID (e.g. 6, #6, owner/repo#6). Omit for bulk update with filters.")
    .option("--title <title>", "Set title")
    .option("--body <body>", "Set body/description")
    .option("--type <type>", "Set task type")
    .option("--state <state>", "Set state (open/closed)")
    .option("--start-date <date>", "Set start date (YYYY-MM-DD or 'none' to clear)")
    .option("--end-date <date>", "Set end date (YYYY-MM-DD or 'none' to clear)")
    .option("--assignee <login>", "Add assignee")
    .option("--remove-assignee <login>", "Remove assignee")
    .option("--assign-implementer <login>", "Set implementer ('none' to clear)")
    .option("--assign-reviewer <login>", "Set reviewer ('none' to clear)")
    .option("--require-review", "Require reviewer approval before close")
    .option("--no-require-review", "Clear per-task review requirement")
    .option("--approve-review <login>", "Mark review as approved by the assigned reviewer")
    .option("--clear-review-approval", "Clear stored review approval")
    .option("--milestone <name>", "Set milestone ('none' to clear)")
    .option("--label <name>", "Add label")
    .option("--status <status>", "Set status (auto-updates dates based on transition)")
    .option("--priority <priority>", "Set priority (critical, high, medium, low)")
    .option("--remove-label <name>", "Remove label")
    .option("--filter-state <state>", "Bulk filter: match tasks by state")
    .option("--filter-type <type>", "Bulk filter: match tasks by type")
    .option("--filter-milestone <name>", "Bulk filter: match tasks by milestone ('none' for unset)")
    .option("--filter-label <name>", "Bulk filter: match tasks by label")
    .option("--no-push", "Do not push this change to GitHub immediately")
    .option("--json", "Output updated task(s) as JSON")
    .action(async (id: string | undefined, opts) => {
      try {
        const projectRoot = process.cwd();
        await withProjectStorage(
          projectRoot,
          { mode: "write", scope: "shared-cache" },
          async (storage) => {
            const { configStore, tasksStore } = storage;
            const config = await configStore.read();
            const tasksFile = await tasksStore.read();

            const updateOpts: TaskUpdateOptions = {
              title: opts.title,
              body: opts.body,
              type: opts.type,
              state: opts.state,
              status: opts.status,
              priority: opts.priority,
              startDate: opts.startDate,
              endDate: opts.endDate,
              assignee: opts.assignee,
              removeAssignee: opts.removeAssignee,
              assignImplementer: opts.assignImplementer,
              assignReviewer: opts.assignReviewer,
              requireReview: opts.requireReview,
              approveReview: opts.approveReview,
              clearReviewApproval: opts.clearReviewApproval,
              evidence: undefined,
              milestone: opts.milestone,
              label: opts.label,
              removeLabel: opts.removeLabel,
            };

            if (id) {
              // 単一taskを更新する
              const resolvedId = resolveTaskId(id, config);
              const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

              if (taskIndex === -1) {
                console.error(`Task not found: ${resolvedId}`);
                process.exitCode = 1;
                return;
              }

              const graphValidation = new WorkGraphCommandEngine(config).executeCommand({
                type: "update",
                tasks: tasksFile.tasks,
                taskId: resolvedId,
                updates: updateOpts,
              });
              if (!graphValidation.ok) {
                console.error(graphValidation.error);
                process.exitCode = 1;
                return;
              }
              tasksFile.tasks = graphValidation.tasks;
              await tasksStore.write(tasksFile);
              await storage.flush();
              const writeThroughResult = await executeWriteThroughPush(
                storage,
                config,
                tasksFile,
                [resolvedId],
                {
                  push: opts.push,
                },
              );
              const persistedTask = writeThroughResult.tasksFile.tasks.find(
                (task) => task.id === resolvedId,
              );
              if (!persistedTask) {
                throw new Error(`Updated task was not persisted: ${resolvedId}`);
              }

              if (opts.json) {
                console.log(JSON.stringify(persistedTask, null, 2));
              } else {
                console.log(`Updated task: ${persistedTask.id}`);
              }
            } else {
              // 複数taskを一括更新する
              const filters: BulkFilterOptions = {
                filterState: opts.filterState,
                filterType: opts.filterType,
                filterMilestone: opts.filterMilestone,
                filterLabel: opts.filterLabel,
              };

              const hasFilter =
                filters.filterState ||
                filters.filterType ||
                filters.filterMilestone ||
                filters.filterLabel;
              if (!hasFilter) {
                console.error("Bulk update requires at least one --filter-* option.");
                process.exitCode = 1;
                return;
              }

              const matched = filterTasksForUpdate(tasksFile.tasks, filters);
              if (matched.length === 0) {
                console.log("No tasks matched the filters.");
                return;
              }

              const updatedTasks: Task[] = [];
              for (const task of matched) {
                const planned = new WorkGraphCommandEngine(config).executeCommand({
                  type: "update",
                  tasks: tasksFile.tasks,
                  taskId: task.id,
                  updates: updateOpts,
                });
                if (!planned.ok) {
                  console.error(`Error updating ${task.id}: ${planned.error}`);
                  continue;
                }
                tasksFile.tasks = planned.tasks;
                updatedTasks.push(tasksFile.tasks.find((candidate) => candidate.id === task.id)!);
              }

              if (updatedTasks.length === 0) {
                console.error("All matched tasks failed to update.");
                process.exitCode = 1;
                return;
              }

              await tasksStore.write(tasksFile);
              await storage.flush();
              const writeThroughResult = await executeWriteThroughPush(
                storage,
                config,
                tasksFile,
                updatedTasks.map((task) => task.id),
                { push: opts.push },
              );
              const updatedIds = new Set(updatedTasks.map((task) => task.id));
              const persistedTasks = writeThroughResult.tasksFile.tasks.filter((task) =>
                updatedIds.has(task.id),
              );

              if (opts.json) {
                console.log(JSON.stringify({ updated: persistedTasks }, null, 2));
              } else {
                console.log(`Updated ${persistedTasks.length} task(s).`);
                for (const t of persistedTasks) {
                  const shortId = t.id.includes("#") ? t.id.split("#")[1] : t.id;
                  console.log(`  ${shortId}: ${t.title}`);
                }
              }
            }
          },
        );
      } catch (err) {
        console.error("Failed to update task:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const taskUpdateCommand = createTaskUpdateCommand();
