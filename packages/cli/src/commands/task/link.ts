import { Command } from "commander";
import { withProjectStorage } from "../../store/project-storage.js";
import { hashTask } from "../../sync/hash.js";
import { resolveTaskId } from "../../util/task-id.js";
import type { Task } from "@gh-gantt/shared";
import { executeWriteThroughPush } from "./write-through-push.js";
import {
  projectDependencyChange,
  projectParentChange,
  WorkGraphCommandEngine,
  type DirectWorkGraphCommand,
} from "../../work-graph/command-engine.js";

export function addDependency(task: Task, blockerTaskId: string): { task: Task; error?: string } {
  const projected = projectDependencyChange(task, { kind: "add_dependency", blockerTaskId });
  return projected.ok ? { task: projected.task } : { task, error: projected.error };
}

export function removeDependency(
  task: Task,
  blockerTaskId: string,
  rawInput?: string,
): { task: Task; error?: string } {
  const projected = projectDependencyChange(task, {
    kind: "remove_dependency",
    blockerTaskId,
    rawInput,
  });
  return projected.ok ? { task: projected.task } : { task, error: projected.error };
}

export function setParent(
  tasks: Task[],
  taskId: string,
  newParentId: string,
): { tasks?: Task[]; error?: string } {
  const projected = projectParentChange(tasks, taskId, {
    kind: "set_parent",
    parentTaskId: newParentId,
  });
  return projected.ok ? { tasks: projected.tasks } : { error: projected.error };
}

export function removeParent(tasks: Task[], taskId: string): Task[] {
  const projected = projectParentChange(tasks, taskId, { kind: "remove_parent" });
  return projected.ok ? projected.tasks : tasks;
}

export function createTaskLinkCommand(): Command {
  return new Command("link")
    .description("Manage task dependencies and parent relationships")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--blocked-by <id>", "Add a blocking dependency")
    .option("--unblock <id>", "Remove a blocking dependency")
    .option("--set-parent <id>", "Set parent task")
    .option("--remove-parent", "Remove parent task")
    .option("--no-push", "Do not push this change to GitHub immediately")
    .option("--json", "Output updated task as JSON")
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
            const originalHashes = new Map(
              tasksFile.tasks.map((task) => [task.id, hashTask(task)]),
            );
            const messages: string[] = [];
            const operations: Extract<DirectWorkGraphCommand, { type: "link" }>["operations"] = [];

            const resolvedId = resolveTaskId(id, config);
            const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

            if (taskIndex === -1) {
              console.error(`Task not found: ${resolvedId}`);
              process.exitCode = 1;
              return;
            }

            if (opts.blockedBy) {
              const blockerId = resolveTaskId(opts.blockedBy, config);
              operations.push({ kind: "add_dependency", blockerTaskId: blockerId });
              messages.push(`Added dependency: ${resolvedId} blocked by ${blockerId}`);
            }

            if (opts.unblock) {
              const blockerId = resolveTaskId(opts.unblock, config);
              operations.push({
                kind: "remove_dependency",
                blockerTaskId: blockerId,
                rawInput: opts.unblock,
              });
              messages.push(`Removed dependency: ${resolvedId} no longer blocked by ${blockerId}`);
            }

            if (opts.setParent) {
              const parentId = resolveTaskId(opts.setParent, config);
              operations.push({ kind: "set_parent", parentTaskId: parentId });
              messages.push(`Set parent: ${resolvedId} → ${parentId}`);
            }

            if (opts.removeParent) {
              operations.push({ kind: "remove_parent" });
              messages.push(`Removed parent from: ${resolvedId}`);
            }

            const graphValidation = new WorkGraphCommandEngine(config).executeCommand({
              type: "link",
              tasks: tasksFile.tasks,
              taskId: resolvedId,
              operations,
            });
            if (!graphValidation.ok) {
              console.error(graphValidation.error);
              process.exitCode = 1;
              return;
            }
            tasksFile.tasks = graphValidation.tasks;

            await tasksStore.write(tasksFile);
            await storage.flush();
            const changedIds = tasksFile.tasks
              .filter((task) => originalHashes.get(task.id) !== hashTask(task))
              .map((task) => task.id);
            const writeThroughResult = await executeWriteThroughPush(
              storage,
              config,
              tasksFile,
              changedIds,
              {
                push: opts.push,
                atomicTargetGroups: [changedIds],
              },
            );

            if (opts.json) {
              const updated = writeThroughResult.tasksFile.tasks.find(
                (task) => task.id === resolvedId,
              );
              console.log(JSON.stringify(updated, null, 2));
            } else {
              for (const message of messages) console.log(message);
            }
          },
        );
      } catch (err) {
        console.error("Failed to link task:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const taskLinkCommand = createTaskLinkCommand();
