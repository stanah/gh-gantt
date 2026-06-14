import { Command } from "commander";
import { normalizeAcceptanceCriteria } from "@gh-gantt/shared";
import type { AcceptanceCriterion, Config, Task } from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { resolveTaskId } from "../util/task-id.js";

export interface AcceptanceCriteriaAddOptions {
  description: string;
}

export interface AcceptanceCriteriaCheckOptions {
  index: number;
}

export function addAcceptanceCriterion(
  task: Task,
  opts: AcceptanceCriteriaAddOptions,
): { task: Task; error?: string } {
  const description = opts.description.replace(/\s+/g, " ").trim();
  if (description.length === 0) {
    return { task, error: "Acceptance criterion description must not be empty." };
  }

  const acceptanceCriteria: AcceptanceCriterion[] = [
    ...normalizeAcceptanceCriteria(task.acceptance_criteria),
    { description, checked: false },
  ];

  return {
    task: {
      ...task,
      acceptance_criteria: acceptanceCriteria,
      updated_at: new Date().toISOString(),
    },
  };
}

export function checkAcceptanceCriterion(
  task: Task,
  opts: AcceptanceCriteriaCheckOptions,
): { task: Task; error?: string } {
  const acceptanceCriteria = normalizeAcceptanceCriteria(task.acceptance_criteria);
  const index = opts.index;
  if (!Number.isInteger(index) || index < 1) {
    return { task, error: "Acceptance criterion index must be a positive integer." };
  }
  if (acceptanceCriteria.length === 0) {
    return { task, error: "Task has no acceptance criteria." };
  }
  if (index > acceptanceCriteria.length) {
    return {
      task,
      error: `Acceptance criterion index ${index} is out of range. Available: 1-${acceptanceCriteria.length}.`,
    };
  }

  const next = acceptanceCriteria.map((criterion, i) =>
    i === index - 1 ? { ...criterion, checked: true } : criterion,
  );

  return {
    task: {
      ...task,
      acceptance_criteria: next,
      updated_at: new Date().toISOString(),
    },
  };
}

function parseIndex(value: string): number {
  return Number(value);
}

async function readTask(id: string, config: Config, tasksStore: TasksStore) {
  const tasksFile = await tasksStore.read();
  const resolvedId = resolveTaskId(id, config);
  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);
  return { tasksFile, resolvedId, taskIndex };
}

export function createAcceptanceCriteriaCommand(): Command {
  const ac = new Command("ac").description("Manage task acceptance criteria");

  ac.command("add")
    .description("Add an acceptance criterion to a task")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .argument("<description>", "Acceptance criterion description")
    .option("--json", "Output updated task as JSON")
    .action(async (id: string, description: string, opts) => {
      try {
        const projectRoot = process.cwd();
        const configStore = new ConfigStore(projectRoot);
        const tasksStore = new TasksStore(projectRoot);
        const config = await configStore.read();
        const { tasksFile, resolvedId, taskIndex } = await readTask(id, config, tasksStore);

        if (taskIndex === -1) {
          console.error(`Task not found: ${resolvedId}`);
          process.exitCode = 1;
          return;
        }

        const result = addAcceptanceCriterion(tasksFile.tasks[taskIndex], { description });
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
          const count = normalizeAcceptanceCriteria(result.task.acceptance_criteria).length;
          console.log(`Added acceptance criterion #${count} to ${resolvedId}.`);
        }
      } catch (err) {
        console.error(
          "Failed to add acceptance criterion:",
          err instanceof Error ? err.message : String(err),
        );
        process.exitCode = 1;
      }
    });

  ac.command("check")
    .description("Mark an acceptance criterion as checked")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .requiredOption("--index <number>", "1-based acceptance criterion index", parseIndex)
    .option("--json", "Output updated task as JSON")
    .action(async (id: string, opts) => {
      try {
        const projectRoot = process.cwd();
        const configStore = new ConfigStore(projectRoot);
        const tasksStore = new TasksStore(projectRoot);
        const config = await configStore.read();
        const { tasksFile, resolvedId, taskIndex } = await readTask(id, config, tasksStore);

        if (taskIndex === -1) {
          console.error(`Task not found: ${resolvedId}`);
          process.exitCode = 1;
          return;
        }

        const result = checkAcceptanceCriterion(tasksFile.tasks[taskIndex], { index: opts.index });
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
          console.log(`Checked acceptance criterion #${opts.index} on ${resolvedId}.`);
        }
      } catch (err) {
        console.error(
          "Failed to check acceptance criterion:",
          err instanceof Error ? err.message : String(err),
        );
        process.exitCode = 1;
      }
    });

  return ac;
}

export const acceptanceCriteriaCommand = createAcceptanceCriteriaCommand();
