import { Command } from "commander";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { resolveTaskId } from "../../util/task-id.js";
import type { Config, Task } from "@gh-gantt/shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TaskUpdateOptions {
  title?: string;
  type?: string;
  state?: "open" | "closed";
  startDate?: string;
  endDate?: string;
  assignee?: string;
  removeAssignee?: string;
  milestone?: string;
  label?: string;
  removeLabel?: string;
}

export function applyTaskUpdate(
  task: Task,
  opts: TaskUpdateOptions,
  config: Config,
): { task: Task; error?: string } {
  if (opts.type && !config.task_types[opts.type]) {
    const typeKeys = Object.keys(config.task_types);
    return {
      task,
      error: `Unknown task type: "${opts.type}". Available: ${typeKeys.join(", ")}`,
    };
  }

  if (opts.state && opts.state !== "open" && opts.state !== "closed") {
    return { task, error: `Invalid state: "${opts.state}". Must be "open" or "closed".` };
  }

  if (opts.startDate && opts.startDate !== "none" && !DATE_RE.test(opts.startDate)) {
    return { task, error: `Invalid start date format: "${opts.startDate}". Use YYYY-MM-DD.` };
  }

  if (opts.endDate && opts.endDate !== "none" && !DATE_RE.test(opts.endDate)) {
    return { task, error: `Invalid end date format: "${opts.endDate}". Use YYYY-MM-DD.` };
  }

  const updated = { ...task };

  if (opts.title) updated.title = opts.title;
  if (opts.type) updated.type = opts.type;
  if (opts.state) updated.state = opts.state;

  if (opts.startDate) {
    updated.start_date = opts.startDate === "none" ? null : opts.startDate;
  }
  if (opts.endDate) {
    updated.end_date = opts.endDate === "none" ? null : opts.endDate;
  }

  if (opts.assignee) {
    if (!updated.assignees.includes(opts.assignee)) {
      updated.assignees = [...updated.assignees, opts.assignee];
    }
  }
  if (opts.removeAssignee) {
    updated.assignees = updated.assignees.filter((a) => a !== opts.removeAssignee);
  }

  if (opts.milestone !== undefined) {
    updated.milestone = opts.milestone === "none" ? null : opts.milestone;
  }

  if (opts.label) {
    if (!updated.labels.includes(opts.label)) {
      updated.labels = [...updated.labels, opts.label];
    }
  }
  if (opts.removeLabel) {
    updated.labels = updated.labels.filter((l) => l !== opts.removeLabel);
  }

  updated.updated_at = new Date().toISOString();

  return { task: updated };
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

export const taskUpdateCommand = new Command("update")
  .description("Update a task (single or bulk)")
  .argument("[id]", "Task ID (e.g. 6, #6, owner/repo#6). Omit for bulk update with filters.")
  .option("--title <title>", "Set title")
  .option("--type <type>", "Set task type")
  .option("--state <state>", "Set state (open/closed)")
  .option("--start-date <date>", "Set start date (YYYY-MM-DD or 'none' to clear)")
  .option("--end-date <date>", "Set end date (YYYY-MM-DD or 'none' to clear)")
  .option("--assignee <login>", "Add assignee")
  .option("--remove-assignee <login>", "Remove assignee")
  .option("--milestone <name>", "Set milestone ('none' to clear)")
  .option("--label <name>", "Add label")
  .option("--remove-label <name>", "Remove label")
  .option("--filter-state <state>", "Bulk filter: match tasks by state")
  .option("--filter-type <type>", "Bulk filter: match tasks by type")
  .option("--filter-milestone <name>", "Bulk filter: match tasks by milestone ('none' for unset)")
  .option("--filter-label <name>", "Bulk filter: match tasks by label")
  .option("--json", "Output updated task(s) as JSON")
  .action(async (id: string | undefined, opts) => {
    try {
      const projectRoot = process.cwd();
      const configStore = new ConfigStore(projectRoot);
      const tasksStore = new TasksStore(projectRoot);

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();

      const updateOpts: TaskUpdateOptions = {
        title: opts.title,
        type: opts.type,
        state: opts.state,
        startDate: opts.startDate,
        endDate: opts.endDate,
        assignee: opts.assignee,
        removeAssignee: opts.removeAssignee,
        milestone: opts.milestone,
        label: opts.label,
        removeLabel: opts.removeLabel,
      };

      if (id) {
        // Single task update
        const resolvedId = resolveTaskId(id, config);
        const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

        if (taskIndex === -1) {
          console.error(`Task not found: ${resolvedId}`);
          process.exitCode = 1;
          return;
        }

        const result = applyTaskUpdate(tasksFile.tasks[taskIndex], updateOpts, config);

        if (result.error) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }

        tasksFile.tasks[taskIndex] = result.task;
        await tasksStore.write(tasksFile);

        if (opts.json) {
          console.log(JSON.stringify(result.task, null, 2));
        } else {
          console.log(`Updated task: ${resolvedId}`);
        }
      } else {
        // Bulk update
        const filters: BulkFilterOptions = {
          filterState: opts.filterState,
          filterType: opts.filterType,
          filterMilestone: opts.filterMilestone,
          filterLabel: opts.filterLabel,
        };

        const hasFilter = filters.filterState || filters.filterType || filters.filterMilestone || filters.filterLabel;
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
          const idx = tasksFile.tasks.findIndex((t) => t.id === task.id);
          const result = applyTaskUpdate(tasksFile.tasks[idx], updateOpts, config);
          if (result.error) {
            console.error(`Error updating ${task.id}: ${result.error}`);
            continue;
          }
          tasksFile.tasks[idx] = result.task;
          updatedTasks.push(result.task);
        }

        await tasksStore.write(tasksFile);

        if (opts.json) {
          console.log(JSON.stringify({ updated: updatedTasks }, null, 2));
        } else {
          console.log(`Updated ${updatedTasks.length} task(s).`);
          for (const t of updatedTasks) {
            const shortId = t.id.includes("#") ? t.id.split("#")[1] : t.id;
            console.log(`  ${shortId}: ${t.title}`);
          }
        }
      }
    } catch (err) {
      console.error("Failed to update task:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
