import { createHash } from "node:crypto";
import type { Task } from "@gh-gantt/shared";

/**
 * Hash only the bidirectional sync fields of a task.
 * Changes to read-only fields (created_at, updated_at, linked_prs, etc.)
 * should not trigger a sync diff.
 */
export function hashTask(task: Task): string {
  const syncFields = {
    title: task.title,
    body: task.body,
    state: task.state,
    type: task.type,
    assignees: [...task.assignees].sort(),
    labels: [...task.labels].sort(),
    milestone: task.milestone,
    custom_fields: task.custom_fields,
    parent: task.parent,
    sub_tasks: [...task.sub_tasks].sort(),
    start_date: task.start_date,
    end_date: task.end_date,
    date: task.date,
    blocked_by: task.blocked_by,
  };

  const json = JSON.stringify(syncFields);
  return createHash("sha256").update(json).digest("hex");
}
