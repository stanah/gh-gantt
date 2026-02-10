import { Command } from "commander";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { resolveTaskId } from "../../util/task-id.js";
import type { Task } from "@gh-gantt/shared";

function formatTask(task: Task): string {
  const lines: string[] = [
    `ID:         ${task.id}`,
    `Title:      ${task.title}`,
    `Type:       ${task.type}`,
    `State:      ${task.state}`,
    `Assignees:  ${task.assignees.length > 0 ? task.assignees.join(", ") : "-"}`,
    `Labels:     ${task.labels.length > 0 ? task.labels.join(", ") : "-"}`,
    `Milestone:  ${task.milestone ?? "-"}`,
    `Start:      ${task.start_date ?? "-"}`,
    `End:        ${task.end_date ?? "-"}`,
    `Date:       ${task.date ?? "-"}`,
    `Parent:     ${task.parent ?? "-"}`,
    `Sub-tasks:  ${task.sub_tasks.length > 0 ? task.sub_tasks.join(", ") : "-"}`,
    `Blocked by: ${task.blocked_by.length > 0 ? task.blocked_by.map((d) => d.task).join(", ") : "-"}`,
    `Created:    ${task.created_at}`,
    `Updated:    ${task.updated_at}`,
  ];
  if (task.body) {
    lines.push("", "--- Body ---", task.body);
  }
  return lines.join("\n");
}

export const taskShowCommand = new Command("show")
  .description("Show task details")
  .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();

    const resolvedId = resolveTaskId(id, config);
    const task = tasksFile.tasks.find((t) => t.id === resolvedId);

    if (!task) {
      console.error(`Task not found: ${resolvedId}`);
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log(formatTask(task));
    }
  });
