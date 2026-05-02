import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { isMilestoneSyntheticTask } from "../../github/issues.js";
import type { Config, Task } from "@gh-gantt/shared";

const RESERVED_TYPES = new Set(["milestone", "milestone_type"]);
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_WITH_TZ_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function isReservedType(type: string): boolean {
  return RESERVED_TYPES.has(type);
}

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
  updatedSince?: string;
  updatedSinceTimestamp?: number;
}

export function filterTasks(tasks: Task[], opts: TaskFilterOptions): Task[] {
  let result = tasks;

  if (opts.backlog) {
    result = result.filter((t) => t.start_date === null && t.end_date === null && t.date === null);
  }

  if (opts.scheduled) {
    result = result.filter((t) => t.start_date !== null || t.end_date !== null || t.date !== null);
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
    result = result.filter((t) => t.custom_fields[fieldName] === opts.status);
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

  if (opts.updatedSince || opts.updatedSinceTimestamp != null) {
    const since = opts.updatedSinceTimestamp ?? parseUpdatedSince(opts.updatedSince ?? "");
    if (since == null || !Number.isFinite(since)) return [];
    result = result.filter((t) => {
      const updatedAt = Date.parse(t.updated_at);
      return Number.isFinite(updatedAt) && updatedAt >= since;
    });
  }

  return result;
}

export function sortTasks(tasks: Task[], sortFields: string, config: Config): Task[] {
  if (!sortFields) return [...tasks];

  const fields = sortFields
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
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
        case "updated_at":
          cmp = compareTimestamps(a.updated_at, b.updated_at);
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

function parseUpdatedSince(value: string): number | null {
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    if (!isValidDateParts(dateOnly[1], dateOnly[2], dateOnly[3])) return null;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const isoDateTime = ISO_DATETIME_WITH_TZ_PATTERN.exec(value);
  if (!isoDateTime) return null;
  if (!isValidDateParts(isoDateTime[1], isoDateTime[2], isoDateTime[3])) return null;
  if (!isValidTimeParts(isoDateTime[4], isoDateTime[5], isoDateTime[6] ?? "00")) return null;
  if (!isValidTimezone(isoDateTime[7])) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidDateParts(yearValue: string, monthValue: string, dayValue: string): boolean {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= getDaysInMonth(year, month);
}

function getDaysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function isValidTimeParts(hourValue: string, minuteValue: string, secondValue: string): boolean {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    Number.isInteger(second) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function isValidTimezone(value: string): boolean {
  if (value === "Z") return true;
  const sign = value[0];
  const [hourValue, minuteValue] = value.slice(1).split(":");
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (
    (sign !== "+" && sign !== "-") ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    minute < 0 ||
    minute > 59
  ) {
    return false;
  }

  return sign === "+"
    ? hour < 14 || (hour === 14 && minute === 0)
    : hour < 12 || (hour === 12 && minute === 0);
}

function compareDates(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareTimestamps(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return aTime - bTime;
}

function formatRelativeUpdatedAt(updatedAt: string, now = new Date()): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "-";

  const diffMs = Math.max(0, now.getTime() - timestamp);
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatShortId(task: Task): string {
  if (isMilestoneSyntheticTask(task.id)) {
    const hash = task.id.indexOf("#");
    return "M" + task.id.substring(hash + 1);
  }
  return task.id.includes("#") ? task.id.split("#")[1] : task.id;
}

export function formatTable(tasks: Task[], now = new Date()): string {
  const hasMilestones = tasks.some((t) => t.type === "milestone");
  const hasNonMilestones = tasks.some((t) => t.type !== "milestone");

  const head =
    hasMilestones && !hasNonMilestones
      ? ["ID", "Type", "Title", "State", "Due", "Updated"]
      : ["ID", "Type", "Title", "State", "Start", "End", "Updated"];

  const table = new Table({
    head,
    style: { head: [], border: [], compact: true },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: "  ",
    },
  });

  for (const t of tasks) {
    const shortId = formatShortId(t);
    const updated = formatRelativeUpdatedAt(t.updated_at, now);
    if (hasMilestones && !hasNonMilestones) {
      table.push([shortId, t.type, t.title, t.state, t.date ?? "-", updated]);
    } else {
      const dates =
        t.type === "milestone" ? [t.date ?? "-", "-"] : [t.start_date ?? "-", t.end_date ?? "-"];
      table.push([shortId, t.type, t.title, t.state, ...dates, updated]);
    }
  }

  return table.toString();
}

export function createTaskListCommand(): Command {
  return new Command("list")
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
    .option(
      "--updated-since <date>",
      "Show tasks updated on or after date (YYYY-MM-DD or ISO datetime with timezone)",
    )
    .option(
      "--sort <fields>",
      "Sort by fields (comma-separated: priority,updated_at,end_date,start_date,type,title)",
    )
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const projectRoot = process.cwd();
      const configStore = new ConfigStore(projectRoot);
      const tasksStore = new TasksStore(projectRoot);

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();

      if (opts.type && !config.task_types[opts.type] && !isReservedType(opts.type)) {
        const typeKeys = Object.keys(config.task_types);
        console.error(`Unknown task type: "${opts.type}". Available: ${typeKeys.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const updatedSinceTimestamp =
        opts.updatedSince != null ? parseUpdatedSince(opts.updatedSince) : undefined;
      if (opts.updatedSince && updatedSinceTimestamp == null) {
        console.error(`Invalid --updated-since date: "${opts.updatedSince}"`);
        process.exitCode = 1;
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
        statusFieldName: config.statuses.field_name,
        label: opts.label,
        search: opts.search,
        updatedSinceTimestamp,
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
}

export const taskListCommand = createTaskListCommand();
