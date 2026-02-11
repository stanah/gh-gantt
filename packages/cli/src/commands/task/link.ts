import { Command } from "commander";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { resolveTaskId } from "../../util/task-id.js";
import type { Config, Task, TasksFile } from "@gh-gantt/shared";

export function addDependency(task: Task, blockerTaskId: string): Task {
  if (task.blocked_by.some((d) => d.task === blockerTaskId)) {
    return task;
  }
  return {
    ...task,
    blocked_by: [
      ...task.blocked_by,
      { task: blockerTaskId, type: "finish-to-start", lag: 0 },
    ],
    updated_at: new Date().toISOString(),
  };
}

export function removeDependency(task: Task, blockerTaskId: string): Task {
  return {
    ...task,
    blocked_by: task.blocked_by.filter((d) => d.task !== blockerTaskId),
    updated_at: new Date().toISOString(),
  };
}

export function setParent(
  tasks: Task[],
  taskId: string,
  newParentId: string,
): Task[] {
  return tasks.map((t) => {
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
  });
}

export function removeParent(tasks: Task[], taskId: string): Task[] {
  const task = tasks.find((t) => t.id === taskId);
  const oldParentId = task?.parent;

  return tasks.map((t) => {
    if (t.id === taskId) {
      return { ...t, parent: null, updated_at: new Date().toISOString() };
    }
    if (oldParentId && t.id === oldParentId) {
      return { ...t, sub_tasks: t.sub_tasks.filter((s) => s !== taskId), updated_at: new Date().toISOString() };
    }
    return t;
  });
}

export const taskLinkCommand = new Command("link")
  .description("Manage task dependencies and parent relationships")
  .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
  .option("--blocked-by <id>", "Add a blocking dependency")
  .option("--unblock <id>", "Remove a blocking dependency")
  .option("--set-parent <id>", "Set parent task")
  .option("--remove-parent", "Remove parent task")
  .option("--json", "Output updated task as JSON")
  .action(async (id: string, opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();

    const resolvedId = resolveTaskId(id, config);
    const taskIndex = tasksFile.tasks.findIndex((t) => t.id === resolvedId);

    if (taskIndex === -1) {
      console.error(`Task not found: ${resolvedId}`);
      process.exitCode = 1;
      return;
    }

    if (opts.blockedBy) {
      const blockerId = resolveTaskId(opts.blockedBy, config);
      tasksFile.tasks[taskIndex] = addDependency(
        tasksFile.tasks[taskIndex],
        blockerId,
      );
      console.log(`Added dependency: ${resolvedId} blocked by ${blockerId}`);
    }

    if (opts.unblock) {
      const blockerId = resolveTaskId(opts.unblock, config);
      tasksFile.tasks[taskIndex] = removeDependency(
        tasksFile.tasks[taskIndex],
        blockerId,
      );
      console.log(`Removed dependency: ${resolvedId} no longer blocked by ${blockerId}`);
    }

    if (opts.setParent) {
      const parentId = resolveTaskId(opts.setParent, config);
      const parentExists = tasksFile.tasks.some((t) => t.id === parentId);
      if (!parentExists) {
        console.error(`Parent task not found: ${parentId}`);
        process.exitCode = 1;
        return;
      }
      tasksFile.tasks = setParent(tasksFile.tasks, resolvedId, parentId);
      console.log(`Set parent: ${resolvedId} → ${parentId}`);
    }

    if (opts.removeParent) {
      tasksFile.tasks = removeParent(tasksFile.tasks, resolvedId);
      console.log(`Removed parent from: ${resolvedId}`);
    }

    await tasksStore.write(tasksFile);

    if (opts.json) {
      const updated = tasksFile.tasks.find((t) => t.id === resolvedId);
      console.log(JSON.stringify(updated, null, 2));
    }
  });
