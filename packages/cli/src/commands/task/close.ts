import { Command } from "commander";
import { withProjectStorage } from "../../store/project-storage.js";
import { resolveTaskId } from "../../util/task-id.js";
import { applyTaskUpdate, type TaskUpdateOptions } from "./update.js";
import { executeWriteThroughPush } from "./write-through-push.js";

export function createTaskCloseCommand(): Command {
  return new Command("close")
    .description("Close a task after review checks")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--approve-review <login>", "Mark review as approved by the assigned reviewer")
    .option("--evidence <summary>", "Record close evidence in the issue body")
    .option("--no-push", "Do not push this change to GitHub immediately")
    .option("--json", "Output closed task as JSON")
    .action(async (id: string, opts) => {
      try {
        const projectRoot = process.cwd();
        await withProjectStorage(
          projectRoot,
          { mode: "write", scope: "shared-cache" },
          async (storage) => {
            const { configStore, tasksStore } = storage;
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
              evidence: opts.evidence,
            };
            const result = applyTaskUpdate(tasksFile.tasks[taskIndex], updateOpts, config);
            if (result.error) {
              console.error(result.error);
              process.exitCode = 1;
              return;
            }

            tasksFile.tasks[taskIndex] = result.task;
            await tasksStore.write(tasksFile);
            await storage.flush();
            await executeWriteThroughPush(storage, config, tasksFile, [resolvedId], {
              push: opts.push,
            });

            const evidence = typeof opts.evidence === "string" ? opts.evidence.trim() : "";
            if (evidence.length === 0 && config.require_close_evidence !== true) {
              console.warn('Warning: closing without evidence. Use --evidence "<summary>".');
            }

            if (opts.json) {
              console.log(JSON.stringify(result.task, null, 2));
            } else {
              console.log(`Closed task: ${resolvedId}`);
            }
          },
        );
      } catch (err) {
        console.error("Failed to close task:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const taskCloseCommand = createTaskCloseCommand();
