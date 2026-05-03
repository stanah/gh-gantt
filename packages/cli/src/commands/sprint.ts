import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../store/config.js";
import type { Config, SprintConfig } from "@gh-gantt/shared";

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

  return command;
}

export const sprintCommand = createSprintCommand();
