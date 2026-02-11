import type { Task, StatusValue } from "../types/index.js";

export function calculateProgress(
  task: Task,
  allTasks: Task[],
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
  visited: Set<string> = new Set(),
): number {
  if (task.state === "closed") return 100;

  const statusName = task.custom_fields[statusFieldName] as string | undefined;
  if (statusName && statusValues[statusName]?.done) return 100;

  if (task.sub_tasks.length > 0) {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    visited.add(task.id);
    let total = 0;
    let done = 0;
    for (const childId of task.sub_tasks) {
      if (visited.has(childId)) continue;
      const child = taskMap.get(childId);
      if (child) {
        total++;
        visited.add(childId);
        done += calculateProgress(child, allTasks, statusValues, statusFieldName, visited) / 100;
      }
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  return 0;
}
