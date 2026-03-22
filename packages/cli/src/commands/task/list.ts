import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { isMilestoneSyntheticTask } from "../../github/issues.js";
import type { Config, Task } from "@gh-gantt/shared";

export interface TaskFilterOptions {
  backlog?: boolean;
  scheduled?: boolean;
  type?: string;
  state?: string;
  unblocked?: boolean;
  assignee?: string;
  unassigned?: boolean;
  status?: string;
  statusFieldName?: string;
  label?: string;
  search?: string;
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

  if (opts.unblocked) {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    result = result.filter((t) => {
      if (t.blocked_by.length === 0) return true;
      return t.blocked_by.every((dep) => {
        const blocker = taskMap.get(dep.task);
        return blocker?.state === "closed";
      });
    });
  }

  if (opts.assignee) {
    const assignee = opts.assignee;
    result = result.filter((t) => t.assignees.includes(assignee));
  }

  if (opts.unassigned) {
    result = result.filter((t) => t.assignees.length === 0);
  }

  if (opts.status && opts.statusFieldName) {
    const fieldName = opts.statusFieldName;
    result = result.filter(
      (t) => t.custom_fields[fieldName] === opts.status,
    );
  }

  if (opts.label) {
    const label = opts.label;
    result = result.filter((t) => t.labels.includes(label));
  }

  if (opts.search) {
    const query = opts.search.toLowerCase();
    result = result.filter((t) => {
      const title = t.title.toLowerCase();
      const body = (t.body ?? "").toLowerCase();
      return title.includes(query) || body.includes(query);
    });
  }

  return result;
}

export function sortTasks(tasks: Task[], sortFields: string, config: Config): Task[] {
  if (!sortFields) return [...tasks];

  const fields = sortFields.split(",").map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0) return [...tasks];

  const typeOrder = Object.keys(config.task_types);
  const typeRank = new Map(typeOrder.map((t, i) => [t, i]));
  const priorityFieldName = config.sync.field_mapping.priority;

  const sorted = [...tasks];
  sorted.sort((a, b) => {
    for (const field of fields) {
      let cmp = 0;
      switch (field) {
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "end_date":
          cmp = compareDates(a.end_date, b.end_date);
          break;
        case "start_date":
          cmp = compareDates(a.start_date, b.start_date);
          break;
        case "type": {
          const aIdx = typeRank.get(a.type) ?? typeOrder.length;
          const bIdx = typeRank.get(b.type) ?? typeOrder.length;
          cmp = aIdx - bIdx;
          break;
        }
        case "priority": {
          if (!priorityFieldName) continue;
          const aVal = String(a.custom_fields[priorityFieldName] ?? "");
          const bVal = String(b.custom_fields[priorityFieldName] ?? "");
          cmp = aVal.localeCompare(bVal);
          if (aVal === "" && bVal !== "") cmp = 1;
          else if (aVal !== "" && bVal === "") cmp = -1;
          break;
        }
      }
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  return sorted;
}

function compareDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
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
  .option("--unblocked", "Show only unblocked tasks (dependencies resolved)")
  .option("--assignee <login>", "Filter by assignee")
  .option("--unassigned", "Show only unassigned tasks")
  .option("--status <status>", "Filter by Status custom field value")
  .option("--label <label>", "Filter by label")
  .option("--search <query>", "Search in title and body")
  .option("--sort <fields>", "Sort by fields (comma-separated: priority,end_date,start_date,type,title)")
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

    let filtered = filterTasks(tasksFile.tasks, {
      backlog: opts.backlog,
      scheduled: opts.scheduled,
      type: opts.type,
      state: opts.state,
      unblocked: opts.unblocked,
      assignee: opts.assignee,
      unassigned: opts.unassigned,
      status: opts.status,
      statusFieldName: config.statuses?.field_name,
      label: opts.label,
      search: opts.search,
    });

    if (opts.sort) {
      filtered = sortTasks(filtered, opts.sort, config);
    }

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
