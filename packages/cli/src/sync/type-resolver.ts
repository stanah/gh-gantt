import type { TaskType } from "@gh-gantt/shared";

export function resolveTaskType(
  labels: string[],
  taskTypes: Record<string, TaskType>,
): string {
  for (const [typeName, typeDef] of Object.entries(taskTypes)) {
    if (typeDef.github_label && labels.includes(typeDef.github_label)) {
      return typeName;
    }
  }
  return "task";
}
