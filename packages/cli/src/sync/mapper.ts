import type { Task, Config } from "@gh-gantt/shared";
import {
  parseAcceptanceCriteriaBody,
  parseTaskReviewBody,
  parseTaskRolesBody,
} from "@gh-gantt/shared";
import type { RawProjectItem } from "../github/projects.js";
import { resolveTaskType } from "./type-resolver.js";
import { buildTaskId } from "../github/issues.js";

export function mapRemoteItemToTask(item: RawProjectItem, config: Config): Task | null {
  if (!item.content) return null;
  const c = item.content;
  const id = buildTaskId(c.repository, c.number);
  const fm = config.sync.field_mapping;
  const taskType = resolveTaskType(
    c.labels,
    item.fieldValues,
    config.task_types,
    fm.type,
    c.issueType,
  );

  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.fieldValues)) {
    customFields[key] = value;
  }
  const parsedRoles = parseTaskRolesBody(c.body);
  const parsedReview = parseTaskReviewBody(parsedRoles.body);
  const parsedBody = parseAcceptanceCriteriaBody(parsedReview.body);

  return {
    id,
    type: taskType,
    github_issue: c.number,
    github_repo: c.repository,
    parent: null,
    sub_tasks: [],
    title: c.title,
    body: parsedBody.body,
    state: c.state as "open" | "closed",
    state_reason: c.stateReason,
    assignees: c.assignees,
    labels: c.labels,
    milestone: c.milestone,
    linked_prs: c.linkedPullRequests,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    closed_at: c.closedAt,
    acceptance_criteria: parsedBody.acceptance_criteria,
    acceptance_criteria_slot: parsedBody.has_acceptance_criteria_block,
    implementer: parsedRoles.implementer,
    reviewer: parsedRoles.reviewer,
    require_review: parsedReview.require_review,
    review_approved_by: parsedReview.review_approved_by,
    review_approved_at: parsedReview.review_approved_at,
    custom_fields: customFields,
    start_date: (item.fieldValues[fm.start_date] as string) ?? null,
    end_date: (item.fieldValues[fm.end_date] as string) ?? null,
    date: null,
    blocked_by: [],
  };
}
