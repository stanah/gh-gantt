import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { statusCommand } from "./commands/status.js";
import { serveCommand } from "./commands/serve.js";
import { createCommand } from "./commands/create.js";
import { createTaskListCommand } from "./commands/task/list.js";
import { createTaskShowCommand } from "./commands/task/show.js";
import { createTaskUpdateCommand } from "./commands/task/update.js";
import { createTaskLinkCommand } from "./commands/task/link.js";
import { conflictsCommand } from "./commands/conflicts.js";
import { resolveCommand } from "./commands/resolve.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("gh-gantt").version("0.1.0").description("GitHub Projects Gantt chart");

  // Top-level commands
  program.addCommand(initCommand);
  program.addCommand(pullCommand);
  program.addCommand(pushCommand);
  program.addCommand(statusCommand);
  program.addCommand(serveCommand);
  program.addCommand(createCommand);
  program.addCommand(conflictsCommand);
  program.addCommand(resolveCommand);

  // Flattened task commands (formerly under `task` subcommand)
  program.addCommand(createTaskListCommand());
  program.addCommand(createTaskShowCommand());
  program.addCommand(createTaskUpdateCommand());
  program.addCommand(createTaskLinkCommand());

  // Backward-compat: `task` subcommand group
  const taskAlias = new Command("task").description(
    "(deprecated) Manage tasks — use top-level commands instead",
  );
  taskAlias.addCommand(createTaskListCommand());
  taskAlias.addCommand(createTaskShowCommand());
  taskAlias.addCommand(createTaskUpdateCommand());
  taskAlias.addCommand(createTaskLinkCommand());
  program.addCommand(taskAlias);

  return program;
}
