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

  updated.updated_at = new Date().toISOString();

  return { task: updated };
}

export const taskUpdateCommand = new Command("update")
  .description("Update a task")
  .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
  .option("--title <title>", "Set title")
  .option("--type <type>", "Set task type")
  .option("--state <state>", "Set state (open/closed)")
  .option("--start-date <date>", "Set start date (YYYY-MM-DD or 'none' to clear)")
  .option("--end-date <date>", "Set end date (YYYY-MM-DD or 'none' to clear)")
  .option("--assignee <login>", "Add assignee")
  .option("--remove-assignee <login>", "Remove assignee")
  .option("--json", "Output updated task as JSON")
  .action(async (id: string, opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();

    const resolvedId = resolveTaskId(id, config);
    const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

    if (taskIndex === -1) {
      console.error(`Task not found: ${resolvedId}`);
      process.exitCode = 1;
      return;
    }

    const result = applyTaskUpdate(tasksFile.tasks[taskIndex], {
      title: opts.title,
      type: opts.type,
      state: opts.state,
      startDate: opts.startDate,
      endDate: opts.endDate,
      assignee: opts.assignee,
      removeAssignee: opts.removeAssignee,
    }, config);

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
  });
