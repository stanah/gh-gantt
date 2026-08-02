import type { TaskType } from "@gh-gantt/shared";

export function resolveTaskType(
  labels: string[],
  customFields: Record<string, unknown>,
  taskTypes: Record<string, TaskType>,
  typeFieldName?: string | null,
  issueTypeName?: string | null,
): string {
  return (
    resolveTaskTypeBinding(labels, customFields, taskTypes, typeFieldName, issueTypeName) ?? "task"
  );
}

/** remote bindingだけからtask typeを解決する。unmappedは安全側でnullを返す。 */
export function resolveTaskTypeBinding(
  labels: string[],
  customFields: Record<string, unknown>,
  taskTypes: Record<string, TaskType>,
  typeFieldName?: string | null,
  issueTypeName?: string | null,
): string | null {
  // 1. Organization Issue Type takes highest priority
  if (issueTypeName) {
    for (const [typeName, typeDef] of Object.entries(taskTypes)) {
      if (typeDef.github_issue_type === issueTypeName) {
        return typeName;
      }
    }
  }

  // 2. Custom field value
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

  // 3. Label-based resolution (fallback)
  for (const [typeName, typeDef] of Object.entries(taskTypes)) {
    if (typeDef.github_label && labels.includes(typeDef.github_label)) {
      return typeName;
    }
  }

  return null;
}
