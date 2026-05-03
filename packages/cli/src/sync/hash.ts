import { createHash } from "node:crypto";
import type { Task, SyncFields } from "@gh-gantt/shared";
import { normalizeAcceptanceCriteria } from "@gh-gantt/shared";

/**
 * Extract the bidirectional sync fields from a task.
 * These are the fields that participate in hash comparison and diff detection.
 */
export function extractSyncFields(task: Task): SyncFields {
  const acceptanceCriteria = normalizeAcceptanceCriteria(task.acceptance_criteria);
  const fields: SyncFields = {
    title: task.title,
    body: task.body,
    state: task.state,
    type: task.type,
    assignees: [...task.assignees].sort(),
    labels: [...task.labels].sort(),
    milestone: task.milestone,
    custom_fields: Object.fromEntries(
      Object.entries(task.custom_fields).sort(([a], [b]) => a.localeCompare(b)),
    ),
    parent: task.parent,
    sub_tasks: [...task.sub_tasks].sort(),
    start_date: task.start_date,
    end_date: task.end_date,
    date: task.date,
    blocked_by: [...task.blocked_by].sort((a, b) => a.task.localeCompare(b.task)),
  };
  if (acceptanceCriteria.length > 0) {
    fields.acceptance_criteria = acceptanceCriteria;
  }
  if (task.acceptance_criteria_slot === true) {
    fields.acceptance_criteria_slot = true;
  }
  if (task.implementer != null) {
    fields.implementer = task.implementer;
  }
  if (task.reviewer != null) {
    fields.reviewer = task.reviewer;
  }
  return fields;
}

/**
 * Hash only the bidirectional sync fields of a task.
 * Changes to read-only fields (created_at, updated_at, linked_prs, etc.)
 * should not trigger a sync diff.
 */
export function hashTask(task: Task): string {
  return hashSyncFields(extractSyncFields(task));
}

export function hashSyncFields(fields: SyncFields): string {
  const json = JSON.stringify(fields);
  return createHash("sha256").update(json).digest("hex");
}
