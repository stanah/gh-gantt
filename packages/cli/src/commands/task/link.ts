import { Command } from "commander";
import { withProjectStorage } from "../../store/project-storage.js";
import { resolveTaskId } from "../../util/task-id.js";
import type { Task } from "@gh-gantt/shared";

export function addDependency(task: Task, blockerTaskId: string): { task: Task; error?: string } {
  if (blockerTaskId === task.id) {
    return { task, error: "A task cannot be blocked by itself." };
  }
  if (task.blocked_by.some((d) => d.task === blockerTaskId)) {
    return { task };
  }
  return {
    task: {
      ...task,
      blocked_by: [...task.blocked_by, { task: blockerTaskId, type: "finish-to-start", lag: 0 }],
      updated_at: new Date().toISOString(),
    },
  };
}

export function removeDependency(
  task: Task,
  blockerTaskId: string,
  rawInput?: string,
): { task: Task; error?: string } {
  // 過去のバグ (#302 以前の create) で保存された非正規形の参照 ("293" 等) も
  // 削除できるよう、正規形に加えて入力の生値 (# 付き入力は # を除いた形も) と
  // 一致判定する
  const removalKeys = new Set([blockerTaskId]);
  if (rawInput !== undefined) {
    removalKeys.add(rawInput);
    if (rawInput.startsWith("#")) removalKeys.add(rawInput.slice(1));
  }
  return {
    task: {
      ...task,
      blocked_by: task.blocked_by.filter((d) => !removalKeys.has(d.task)),
      updated_at: new Date().toISOString(),
    },
  };
}

export function setParent(
  tasks: Task[],
  taskId: string,
  newParentId: string,
): { tasks?: Task[]; error?: string } {
  if (taskId === newParentId) {
    return { error: "A task cannot be its own parent." };
  }
  if (!tasks.some((t) => t.id === newParentId)) {
    return { error: `Parent task not found: ${newParentId}` };
  }
  return {
    tasks: tasks.map((t) => {
      if (t.id === taskId) {
        return { ...t, parent: newParentId, updated_at: new Date().toISOString() };
      }
      // Remove from old parent's sub_tasks
      if (t.sub_tasks.includes(taskId) && t.id !== newParentId) {
        return { ...t, sub_tasks: t.sub_tasks.filter((s) => s !== taskId) };
      }
      // Add to new parent's sub_tasks
      if (t.id === newParentId && !t.sub_tasks.includes(taskId)) {
        return { ...t, sub_tasks: [...t.sub_tasks, taskId] };
      }
      return t;
    }),
  };
}

export function removeParent(tasks: Task[], taskId: string): Task[] {
  const task = tasks.find((t) => t.id === taskId);
  const oldParentId = task?.parent;

  return tasks.map((t) => {
    if (t.id === taskId) {
      return { ...t, parent: null, updated_at: new Date().toISOString() };
    }
    if (oldParentId && t.id === oldParentId) {
      return {
        ...t,
        sub_tasks: t.sub_tasks.filter((s) => s !== taskId),
        updated_at: new Date().toISOString(),
      };
    }
    return t;
  });
}

export function createTaskLinkCommand(): Command {
  return new Command("link")
    .description("Manage task dependencies and parent relationships")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--blocked-by <id>", "Add a blocking dependency")
    .option("--unblock <id>", "Remove a blocking dependency")
    .option("--set-parent <id>", "Set parent task")
    .option("--remove-parent", "Remove parent task")
    .option("--json", "Output updated task as JSON")
    .action(async (id: string, opts) => {
      const projectRoot = process.cwd();
      return withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore } = storage;
          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const messages: string[] = [];

          const resolvedId = resolveTaskId(id, config);
          const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

          if (taskIndex === -1) {
            console.error(`Task not found: ${resolvedId}`);
            process.exitCode = 1;
            return;
          }

          if (opts.blockedBy) {
            const blockerId = resolveTaskId(opts.blockedBy, config);
            const depResult = addDependency(tasksFile.tasks[taskIndex], blockerId);
            if (depResult.error) {
              console.error(depResult.error);
              process.exitCode = 1;
              return;
            }
            tasksFile.tasks[taskIndex] = depResult.task;
            messages.push(`Added dependency: ${resolvedId} blocked by ${blockerId}`);
          }

          if (opts.unblock) {
            const blockerId = resolveTaskId(opts.unblock, config);
            const unblockResult = removeDependency(
              tasksFile.tasks[taskIndex],
              blockerId,
              opts.unblock,
            );
            tasksFile.tasks[taskIndex] = unblockResult.task;
            messages.push(`Removed dependency: ${resolvedId} no longer blocked by ${blockerId}`);
          }

          if (opts.setParent) {
            const parentId = resolveTaskId(opts.setParent, config);
            const parentResult = setParent(tasksFile.tasks, resolvedId, parentId);
            if (parentResult.error) {
              console.error(parentResult.error);
              process.exitCode = 1;
              return;
            }
            tasksFile.tasks = parentResult.tasks!;
            messages.push(`Set parent: ${resolvedId} → ${parentId}`);
          }

          if (opts.removeParent) {
            tasksFile.tasks = removeParent(tasksFile.tasks, resolvedId);
            messages.push(`Removed parent from: ${resolvedId}`);
          }

          await tasksStore.write(tasksFile);
          await storage.flush();

          if (opts.json) {
            const updated = tasksFile.tasks.find((t) => t.id === resolvedId);
            console.log(JSON.stringify(updated, null, 2));
          } else {
            for (const message of messages) console.log(message);
          }
        },
      );
    });
}

export const taskLinkCommand = createTaskLinkCommand();
