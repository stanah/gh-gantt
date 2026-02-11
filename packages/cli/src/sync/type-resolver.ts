import type { TaskType } from "@gh-gantt/shared";

export function resolveTaskType(
  labels: string[],
  customFields: Record<string, unknown>,
  taskTypes: Record<string, TaskType>,
  typeFieldName?: string | null,
): string {
  // 1. Custom field value takes highest priority
  if (typeFieldName) {
    const fieldValue = customFields[typeFieldName] as string | undefined;
    if (fieldValue) {
      for (const [typeName, typeDef] of Object.entries(taskTypes)) {
        if (typeDef.github_field_value && typeDef.github_field_value === fieldValue) {
          return typeName;
        }
      }
    }
  }

  // 2. Label-based resolution (fallback)
  for (const [typeName, typeDef] of Object.entries(taskTypes)) {
    if (typeDef.github_label && labels.includes(typeDef.github_label)) {
      return typeName;
    }
  }

  // 3. Default
  return "task";
}
