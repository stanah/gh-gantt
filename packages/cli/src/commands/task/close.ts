import { Command } from "commander";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { resolveTaskId } from "../../util/task-id.js";
import { applyTaskUpdate, type TaskUpdateOptions } from "./update.js";

export function createTaskCloseCommand(): Command {
  return new Command("close")
    .description("Close a task after review checks")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--approve-review <login>", "Mark review as approved by the assigned reviewer")
    .option("--json", "Output closed task as JSON")
    .action(async (id: string, opts) => {
      try {
        const projectRoot = process.cwd();
        const configStore = new ConfigStore(projectRoot);
        const tasksStore = new TasksStore(projectRoot);

        const config = await configStore.read();
        const tasksFile = await tasksStore.read();
        const resolvedId = resolveTaskId(id, config);
        const taskIndex = tasksFile.tasks.findIndex((task) => task.id === resolvedId);

        if (taskIndex === -1) {
          console.error(`Task not found: ${resolvedId}`);
          process.exitCode = 1;
          return;
        }

        const updateOpts: TaskUpdateOptions = {
          state: "closed",
          approveReview: opts.approveReview,
        };
        const result = applyTaskUpdate(tasksFile.tasks[taskIndex], updateOpts, config);
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
          console.log(`Closed task: ${resolvedId}`);
        }
      } catch (err) {
        console.error("Failed to close task:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const taskCloseCommand = createTaskCloseCommand();
