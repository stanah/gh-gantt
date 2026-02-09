#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";

const program = new Command();
program.name("gh-gantt").version("0.1.0").description("GitHub Projects Gantt chart");
program.addCommand(initCommand);
program.parse();
