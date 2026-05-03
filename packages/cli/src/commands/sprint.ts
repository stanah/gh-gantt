import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { resolveTaskId } from "../util/task-id.js";
import type { Config, SprintConfig, Task, TasksFile } from "@gh-gantt/shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface SprintCreateOptions {
  startDate?: string;
  endDate?: string;
  color?: string;
}

export interface SprintUpdateOptions {
  name?: string;
  startDate?: string;
  endDate?: string;
  color?: string;
}

export interface SprintMutationResult {
  config: Config;
  sprint?: SprintConfig;
  deleted?: SprintConfig;
  error?: string;
}

export interface SprintAssignResult {
  tasks: Task[];
  sprint?: SprintConfig;
  updated?: Task[];
  error?: string;
}

export interface SprintCarryOverResult {
  tasks: Task[];
  from?: SprintConfig;
  to?: SprintConfig;
  updated?: Task[];
  error?: string;
}

function normalizeName(name: string): string {
  return name.trim();
}

function isValidDateOnly(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validateSprintFields(sprint: SprintConfig): string | undefined {
  if (sprint.name.length === 0) {
    return "Sprint name must not be empty.";
  }
  if (!isValidDateOnly(sprint.start_date)) {
    return `Invalid start date format: "${sprint.start_date}". Use YYYY-MM-DD.`;
  }
  if (!isValidDateOnly(sprint.end_date)) {
    return `Invalid end date format: "${sprint.end_date}". Use YYYY-MM-DD.`;
  }
  if (sprint.start_date > sprint.end_date) {
    return `Invalid date range: start_date (${sprint.start_date}) is after end_date (${sprint.end_date}).`;
  }
  if (!HEX_COLOR_RE.test(sprint.color)) {
    return `Invalid color: "${sprint.color}". Use #RRGGBB.`;
  }
  return undefined;
}

function withSprints(config: Config, sprints: SprintConfig[]): Config {
  return {
    ...config,
    sprints,
  };
}

function sprintIndex(sprints: SprintConfig[], name: string): number {
  const normalized = normalizeName(name);
  return sprints.findIndex((sprint) => sprint.name === normalized);
}

export function listSprints(config: Config): SprintConfig[] {
  return [...(config.sprints ?? [])];
}

export function createSprint(
  config: Config,
  name: string,
  options: SprintCreateOptions,
): SprintMutationResult {
  const sprints = listSprints(config);
  const sprint: SprintConfig = {
    name: normalizeName(name),
    start_date: options.startDate ?? "",
    end_date: options.endDate ?? "",
    color: options.color ?? "#3b82f6",
  };

  const validationError = validateSprintFields(sprint);
  if (validationError) return { config, error: validationError };
  if (sprintIndex(sprints, sprint.name) !== -1) {
    return { config, error: `Sprint already exists: "${sprint.name}".` };
  }

  const nextConfig = withSprints(config, [...sprints, sprint]);
  return { config: nextConfig, sprint };
}

export function updateSprint(
  config: Config,
  name: string,
  options: SprintUpdateOptions,
): SprintMutationResult {
  const sprints = listSprints(config);
  const index = sprintIndex(sprints, name);
  if (index === -1) return { config, error: `Sprint not found: "${name}".` };

  const current = sprints[index];
  const sprint: SprintConfig = {
    name: options.name !== undefined ? normalizeName(options.name) : current.name,
    start_date: options.startDate ?? current.start_date,
    end_date: options.endDate ?? current.end_date,
    color: options.color ?? current.color,
  };

  const validationError = validateSprintFields(sprint);
  if (validationError) return { config, error: validationError };

  const duplicateIndex = sprintIndex(sprints, sprint.name);
  if (duplicateIndex !== -1 && duplicateIndex !== index) {
    return { config, error: `Sprint already exists: "${sprint.name}".` };
  }

  const nextSprints = [...sprints];
  nextSprints[index] = sprint;
  return { config: withSprints(config, nextSprints), sprint };
}

export function deleteSprint(config: Config, name: string): SprintMutationResult {
  const sprints = listSprints(config);
  const index = sprintIndex(sprints, name);
  if (index === -1) return { config, error: `Sprint not found: "${name}".` };

  const deleted = sprints[index];
  const nextSprints = sprints.filter((_, i) => i !== index);
  return { config: withSprints(config, nextSprints), deleted };
}

function findSprint(config: Config, name: string): SprintConfig | undefined {
  const sprints = listSprints(config);
  const index = sprintIndex(sprints, name);
  return index === -1 ? undefined : sprints[index];
}

function moveTaskToSprint(task: Task, sprint: SprintConfig): Task {
  return {
    ...task,
    start_date: sprint.start_date,
    end_date: sprint.end_date,
    updated_at: new Date().toISOString(),
  };
}

function isTaskDone(task: Task, config: Config): boolean {
  if (task.state === "closed") return true;
  const status = task.custom_fields[config.statuses.field_name];
  return typeof status === "string" && config.statuses.values[status]?.done === true;
}

function isTaskWithinSprint(task: Task, sprint: SprintConfig): boolean {
  return (
    task.start_date !== null &&
    task.end_date !== null &&
    task.start_date >= sprint.start_date &&
    task.end_date <= sprint.end_date
  );
}

export function assignTasksToSprint(
  config: Config,
  tasks: Task[],
  sprintName: string,
  taskIds: string[],
): SprintAssignResult {
  const sprint = findSprint(config, sprintName);
  if (!sprint) return { tasks, error: `Sprint not found: "${sprintName}".` };
  if (taskIds.length === 0) return { tasks, error: "Specify at least one task." };

  const taskSet = new Set(taskIds);
  const missing = taskIds.filter((id) => !tasks.some((task) => task.id === id));
  if (missing.length > 0) return { tasks, error: `Task not found: ${missing.join(", ")}` };

  const updated: Task[] = [];
  const nextTasks = tasks.map((task) => {
    if (!taskSet.has(task.id)) return task;
    const moved = moveTaskToSprint(task, sprint);
    updated.push(moved);
    return moved;
  });

  return { tasks: nextTasks, sprint, updated };
}

export function carryOverSprintTasks(
  config: Config,
  tasks: Task[],
  fromName: string,
  toName: string,
): SprintCarryOverResult {
  const from = findSprint(config, fromName);
  if (!from) return { tasks, error: `Sprint not found: "${fromName}".` };
  const to = findSprint(config, toName);
  if (!to) return { tasks, error: `Sprint not found: "${toName}".` };
  if (from.name === to.name) return { tasks, error: "Source and target sprint must differ." };

  const updated: Task[] = [];
  const nextTasks = tasks.map((task) => {
    if (isTaskDone(task, config) || !isTaskWithinSprint(task, from)) return task;
    const moved = moveTaskToSprint(task, to);
    updated.push(moved);
    return moved;
  });

  return { tasks: nextTasks, from, to, updated };
}

function formatSprintTable(sprints: SprintConfig[]): string {
  const table = new Table({
    head: ["Name", "Start", "End", "Color"],
    style: { head: ["cyan"] },
  });

  for (const sprint of sprints) {
    table.push([sprint.name, sprint.start_date, sprint.end_date, sprint.color]);
  }

  return table.toString();
}

async function readConfig(): Promise<{ store: ConfigStore; config: Config }> {
  const store = new ConfigStore(process.cwd());
  const config = await store.read();
  return { store, config };
}

async function readProject(): Promise<{
  config: Config;
  tasksStore: TasksStore;
  tasksFile: TasksFile;
}> {
  const projectRoot = process.cwd();
  const config = await new ConfigStore(projectRoot).read();
  const tasksStore = new TasksStore(projectRoot);
  const tasksFile = await tasksStore.read();
  return { config, tasksStore, tasksFile };
}

function shortTaskId(task: Task): string {
  return task.id.includes("#") ? task.id.split("#")[1]! : task.id;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

export function createSprintCommand(): Command {
  const command = new Command("sprint").description("Manage sprint config");

  command
    .command("list")
    .description("List configured sprints")
    .option("--json", "Output sprints as JSON")
    .action(async (opts) => {
      try {
        const { config } = await readConfig();
        const sprints = listSprints(config);
        if (opts.json) {
          console.log(JSON.stringify({ sprints }, null, 2));
          return;
        }
        if (sprints.length === 0) {
          console.log("No sprints configured.");
          return;
        }
        console.log(formatSprintTable(sprints));
      } catch (err) {
        fail(`Failed to list sprints: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  command
    .command("create")
    .description("Create a sprint in config")
    .argument("<name>", "Sprint name")
    .requiredOption("--start-date <date>", "Start date (YYYY-MM-DD)")
    .requiredOption("--end-date <date>", "End date (YYYY-MM-DD)")
    .requiredOption("--color <hex>", "Sprint color (#RRGGBB)")
    .option("--json", "Output created sprint as JSON")
    .action(async (name: string, opts) => {
      try {
        const { store, config } = await readConfig();
        const result = createSprint(config, name, opts);
        if (result.error || !result.sprint) {
          fail(result.error ?? "Failed to create sprint.");
          return;
        }
        await store.write(result.config);
        if (opts.json) {
          console.log(
            JSON.stringify({ sprint: result.sprint, sprints: result.config.sprints }, null, 2),
          );
        } else {
          console.log(`Created sprint: ${result.sprint.name}`);
        }
      } catch (err) {
        fail(`Failed to create sprint: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  command
    .command("update")
    .description("Update a sprint in config")
    .argument("<name>", "Current sprint name")
    .option("--name <name>", "New sprint name")
    .option("--start-date <date>", "Start date (YYYY-MM-DD)")
    .option("--end-date <date>", "End date (YYYY-MM-DD)")
    .option("--color <hex>", "Sprint color (#RRGGBB)")
    .option("--json", "Output updated sprint as JSON")
    .action(async (name: string, opts) => {
      try {
        const { store, config } = await readConfig();
        const hasUpdate =
          opts.name !== undefined ||
          opts.startDate !== undefined ||
          opts.endDate !== undefined ||
          opts.color !== undefined;
        if (!hasUpdate) {
          fail("Specify at least one update option.");
          return;
        }
        const result = updateSprint(config, name, opts);
        if (result.error || !result.sprint) {
          fail(result.error ?? "Failed to update sprint.");
          return;
        }
        await store.write(result.config);
        if (opts.json) {
          console.log(
            JSON.stringify({ sprint: result.sprint, sprints: result.config.sprints }, null, 2),
          );
        } else {
          console.log(`Updated sprint: ${result.sprint.name}`);
        }
      } catch (err) {
        fail(`Failed to update sprint: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  command
    .command("delete")
    .description("Delete a sprint from config")
    .argument("<name>", "Sprint name")
    .option("--json", "Output deleted sprint as JSON")
    .action(async (name: string, opts) => {
      try {
        const { store, config } = await readConfig();
        const result = deleteSprint(config, name);
        if (result.error || !result.deleted) {
          fail(result.error ?? "Failed to delete sprint.");
          return;
        }
        await store.write(result.config);
        if (opts.json) {
          console.log(
            JSON.stringify({ deleted: result.deleted, sprints: result.config.sprints }, null, 2),
          );
        } else {
          console.log(`Deleted sprint: ${result.deleted.name}`);
        }
      } catch (err) {
        fail(`Failed to delete sprint: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  command
    .command("assign")
    .description("Move tasks into a sprint date range")
    .argument("<sprint>", "Sprint name")
    .argument("<task...>", "Task IDs to assign")
    .option("--json", "Output updated tasks as JSON")
    .action(async (sprintName: string, taskIds: string[], opts) => {
      try {
        const { config, tasksStore, tasksFile } = await readProject();
        const resolvedTaskIds = taskIds.map((id) => resolveTaskId(id, config));
        const result = assignTasksToSprint(config, tasksFile.tasks, sprintName, resolvedTaskIds);
        if (result.error || !result.sprint || !result.updated) {
          fail(result.error ?? "Failed to assign tasks to sprint.");
          return;
        }
        await tasksStore.write({ ...tasksFile, tasks: result.tasks });
        if (opts.json) {
          console.log(JSON.stringify({ sprint: result.sprint, updated: result.updated }, null, 2));
        } else {
          console.log(`Assigned ${result.updated.length} task(s) to sprint: ${result.sprint.name}`);
          for (const task of result.updated) {
            console.log(`  ${shortTaskId(task)}: ${task.title}`);
          }
        }
      } catch (err) {
        fail(`Failed to assign sprint: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  command
    .command("carry-over")
    .description("Move unfinished tasks from one sprint to another")
    .argument("<from>", "Source sprint name")
    .argument("<to>", "Target sprint name")
    .option("--json", "Output carried-over tasks as JSON")
    .action(async (fromName: string, toName: string, opts) => {
      try {
        const { config, tasksStore, tasksFile } = await readProject();
        const result = carryOverSprintTasks(config, tasksFile.tasks, fromName, toName);
        if (result.error || !result.from || !result.to || !result.updated) {
          fail(result.error ?? "Failed to carry over sprint tasks.");
          return;
        }
        await tasksStore.write({ ...tasksFile, tasks: result.tasks });
        if (opts.json) {
          console.log(
            JSON.stringify({ from: result.from, to: result.to, updated: result.updated }, null, 2),
          );
        } else if (result.updated.length === 0) {
          console.log(`No unfinished tasks found in sprint: ${result.from.name}`);
        } else {
          console.log(
            `Carried over ${result.updated.length} task(s): ${result.from.name} → ${result.to.name}`,
          );
          for (const task of result.updated) {
            console.log(`  ${shortTaskId(task)}: ${task.title}`);
          }
        }
      } catch (err) {
        fail(`Failed to carry over sprint: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return command;
}

export const sprintCommand = createSprintCommand();
