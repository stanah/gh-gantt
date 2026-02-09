import type { Task } from "@gh-gantt/shared";
import type { RawProjectItem } from "./projects.js";
import type { SubIssueLink } from "./sub-issues.js";

export function buildTaskId(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export function mapProjectItemToTask(
  item: RawProjectItem,
  fieldMapping: { start_date: string; end_date: string; status: string },
  taskType: string,
): Task | null {
  if (!item.content) return null;
  const c = item.content;
  const id = buildTaskId(c.repository, c.number);

  const mappedFields = new Set([fieldMapping.start_date, fieldMapping.end_date, "Title"]);
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.fieldValues)) {
    if (!mappedFields.has(key)) {
      customFields[key] = value;
    }
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
    start_date: (item.fieldValues[fieldMapping.start_date] as string) ?? null,
    end_date: (item.fieldValues[fieldMapping.end_date] as string) ?? null,
    date: null,
    blocked_by: [],
  };
}

export function applySubIssueLinks(tasks: Task[], links: SubIssueLink[]): void {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const link of links) {
    const parentId = buildTaskId(link.parentRepo, link.parentNumber);
    const childId = buildTaskId(link.childRepo, link.childNumber);
    const parent = taskMap.get(parentId);
    const child = taskMap.get(childId);

    if (parent && child) {
      if (!parent.sub_tasks.includes(childId)) {
        parent.sub_tasks.push(childId);
      }
      child.parent = parentId;
    }
  }
}
