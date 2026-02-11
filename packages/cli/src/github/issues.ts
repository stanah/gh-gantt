import type { Task } from "@gh-gantt/shared";
import { DRAFT_PREFIX } from "@gh-gantt/shared";
import type { RawProjectItem, RawMilestone } from "./projects.js";
import type { SubIssueLink } from "./sub-issues.js";

const MILESTONE_PREFIX = "milestone:";

export function isMilestoneSyntheticTask(taskId: string): boolean {
  return taskId.startsWith(MILESTONE_PREFIX);
}

export function buildMilestoneSyntheticId(repo: string, milestoneNumber: number): string {
  return `${MILESTONE_PREFIX}${repo}#${milestoneNumber}`;
}

export function isMilestoneDraftTask(task: Task): boolean {
  return isDraftTask(task.id) && task.type === "milestone";
}

export function milestoneToTask(m: RawMilestone, repo: string): Task {
  return {
    id: `${MILESTONE_PREFIX}${repo}#${m.number}`,
    type: "milestone",
    github_issue: null,
    github_repo: repo,
    parent: null,
    sub_tasks: [],
    title: m.title,
    body: m.description ?? null,
    state: m.state === "OPEN" ? "open" : "closed",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "",
    updated_at: "",
    closed_at: m.closedAt ?? null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: m.dueOn,
    blocked_by: [],
  };
}

export function buildTaskId(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

export function buildDraftTaskId(repo: string, draftNumber: number): string {
  return `${repo}#${DRAFT_PREFIX}${draftNumber}`;
}

export function isDraftTask(taskId: string): boolean {
  const hash = taskId.indexOf("#");
  if (hash === -1) return false;
  return taskId.substring(hash + 1).startsWith(DRAFT_PREFIX);
}

export function getNextDraftNumber(tasks: Task[]): number {
  let max = 0;
  for (const task of tasks) {
    if (!isDraftTask(task.id)) continue;
    const hash = task.id.indexOf("#");
    const num = parseInt(task.id.substring(hash + 1 + DRAFT_PREFIX.length), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return max + 1;
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
