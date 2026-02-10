import { Command } from "commander";
import { taskListCommand } from "./list.js";
import { taskShowCommand } from "./show.js";
import { taskUpdateCommand } from "./update.js";
import { taskLinkCommand } from "./link.js";

export const taskCommand = new Command("task").description("Manage tasks");
taskCommand.addCommand(taskListCommand);
taskCommand.addCommand(taskShowCommand);
taskCommand.addCommand(taskUpdateCommand);
taskCommand.addCommand(taskLinkCommand);
