import type { Task, StatusValue } from "../types/index.js";

export function calculateProgress(
  task: Task,
  allTasks: Task[],
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
): number {
  if (task.state === "closed") return 100;

  const statusName = task.custom_fields[statusFieldName] as string | undefined;
  if (statusName && statusValues[statusName]?.done) return 100;

  if (task.sub_tasks.length > 0) {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    let total = 0;
    let done = 0;
    for (const childId of task.sub_tasks) {
      const child = taskMap.get(childId);
      if (child) {
        total++;
        done += calculateProgress(child, allTasks, statusValues, statusFieldName) / 100;
      }
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  return 0;
}
