import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { isMilestoneSyntheticTask } from "../../github/issues.js";
import type { Task } from "@gh-gantt/shared";

export interface TaskFilterOptions {
  backlog?: boolean;
  scheduled?: boolean;
  type?: string;
  state?: string;
}

export function filterTasks(tasks: Task[], opts: TaskFilterOptions): Task[] {
  let result = tasks;

  if (opts.backlog) {
    result = result.filter(
      (t) => t.start_date === null && t.end_date === null && t.date === null,
    );
  }

  if (opts.scheduled) {
    result = result.filter(
      (t) => t.start_date !== null || t.end_date !== null || t.date !== null,
    );
  }

  if (opts.type) {
    result = result.filter((t) => t.type === opts.type);
  }

  if (opts.state) {
    result = result.filter((t) => t.state === opts.state);
  }

  return result;
}

function formatShortId(task: Task): string {
  if (isMilestoneSyntheticTask(task.id)) {
    const hash = task.id.indexOf("#");
    return "M" + task.id.substring(hash + 1);
  }
  return task.id.includes("#") ? task.id.split("#")[1] : task.id;
}

function formatTable(tasks: Task[]): string {
  const hasMilestones = tasks.some((t) => t.type === "milestone");
  const hasNonMilestones = tasks.some((t) => t.type !== "milestone");

  const head = hasMilestones && !hasNonMilestones
    ? ["ID", "Type", "Title", "State", "Due"]
    : ["ID", "Type", "Title", "State", "Start", "End"];

  const table = new Table({
    head,
    style: { head: [], border: [], compact: true },
    chars: {
      top: "", "top-mid": "", "top-left": "", "top-right": "",
      bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
      left: "", "left-mid": "", mid: "", "mid-mid": "",
      right: "", "right-mid": "", middle: "  ",
    },
  });

  for (const t of tasks) {
    const shortId = formatShortId(t);
    if (hasMilestones && !hasNonMilestones) {
      table.push([shortId, t.type, t.title, t.state, t.date ?? "-"]);
    } else {
      const dates = t.type === "milestone"
        ? [t.date ?? "-", "-"]
        : [t.start_date ?? "-", t.end_date ?? "-"];
      table.push([shortId, t.type, t.title, t.state, ...dates]);
    }
  }

  return table.toString();
}

export const taskListCommand = new Command("list")
  .description("List tasks")
  .option("--backlog", "Show only backlog tasks (no dates)")
  .option("--scheduled", "Show only scheduled tasks (have dates)")
  .option("--type <type>", "Filter by task type")
  .option("--state <state>", "Filter by state (open/closed)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();

    if (opts.type && !config.task_types[opts.type]) {
      const typeKeys = Object.keys(config.task_types);
      console.error(
        `Unknown task type: "${opts.type}". Available: ${typeKeys.join(", ")}`,
      );
      return;
    }

    const filtered = filterTasks(tasksFile.tasks, {
      backlog: opts.backlog,
      scheduled: opts.scheduled,
      type: opts.type,
      state: opts.state,
    });

    if (opts.json) {
      console.log(JSON.stringify({ tasks: filtered }, null, 2));
    } else {
      if (filtered.length === 0) {
        console.log("No tasks found.");
      } else {
        console.log(formatTable(filtered));
      }
    }
  });
