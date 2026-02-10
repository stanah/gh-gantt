#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { statusCommand } from "./commands/status.js";
import { serveCommand } from "./commands/serve.js";
import { createCommand } from "./commands/create.js";
import { taskCommand } from "./commands/task/index.js";

const program = new Command();
program.name("gh-gantt").version("0.1.0").description("GitHub Projects Gantt chart");
program.addCommand(initCommand);
program.addCommand(pullCommand);
program.addCommand(pushCommand);
program.addCommand(statusCommand);
program.addCommand(serveCommand);
program.addCommand(createCommand);
program.addCommand(taskCommand);
program.parse();
