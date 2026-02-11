import type { Task, Config } from "@gh-gantt/shared";
import type { RawProjectItem } from "../github/projects.js";
import { resolveTaskType } from "./type-resolver.js";
import { buildTaskId } from "../github/issues.js";

export function mapRemoteItemToTask(
  item: RawProjectItem,
  config: Config,
): Task | null {
  if (!item.content) return null;
  const c = item.content;
  const id = buildTaskId(c.repository, c.number);
  const fm = config.sync.field_mapping;
  const taskType = resolveTaskType(
    c.labels,
    c.milestone,
    item.fieldValues,
    config.task_types,
    fm.type,
  );

  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.fieldValues)) {
    customFields[key] = value;
  }

  return {
    id,
    type: taskType,
    github_issue: c.number,
    github_repo: c.repository,
    parent: null,
    sub_tasks: [],
    title: c.title,
    body: c.body,
    state: c.state as "open" | "closed",
    state_reason: c.stateReason,
    assignees: c.assignees,
    labels: c.labels,
    milestone: c.milestone,
    linked_prs: [],
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    closed_at: c.closedAt,
    custom_fields: customFields,
    start_date: (item.fieldValues[fm.start_date] as string) ?? null,
    end_date: (item.fieldValues[fm.end_date] as string) ?? null,
    date: null,
    blocked_by: [],
  };
}

export function mergeRemoteIntoLocal(
  localTask: Task,
  remoteTask: Task,
  options?: { typeFieldConfigured?: boolean },
): Task {
  return {
    ...remoteTask,
    // Preserve local-only fields
    blocked_by: localTask.blocked_by,
    // Use remote type when custom field mapping is configured; otherwise preserve local
    type: options?.typeFieldConfigured ? remoteTask.type : localTask.type,
  };
}
