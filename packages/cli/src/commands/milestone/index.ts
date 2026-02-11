import { Command } from "commander";
import { milestoneListCommand } from "./list.js";
import { milestoneCreateCommand } from "./create.js";

export const milestoneCommand = new Command("milestone").description("Manage milestones");
milestoneCommand.addCommand(milestoneListCommand);
milestoneCommand.addCommand(milestoneCreateCommand);
