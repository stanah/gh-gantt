import {
  DEFAULT_ESTIMATE_HOURS_FIELD,
  parseEstimateHours,
  serializeAcceptanceCriteriaBody,
  serializeTaskReviewBody,
  serializeTaskRolesBody,
  type Config,
  type Task,
} from "@gh-gantt/shared";

export function serializeTaskBodyForGithub(task: Task): string | undefined {
  const acceptanceBody = serializeAcceptanceCriteriaBody(task.body, task.acceptance_criteria, {
    includeEmptyBlock: task.acceptance_criteria_slot === true,
  });
  const rolesBody = serializeTaskRolesBody(acceptanceBody, {
    implementer: task.implementer,
    reviewer: task.reviewer,
  });
  return (
    serializeTaskReviewBody(rolesBody, {
      require_review: task.require_review,
      review_approved_by: task.review_approved_by,
      review_approved_at: task.review_approved_at,
    }) ?? undefined
  );
}

export function canonicalBlockedBy(value: Task["blocked_by"]): Task["blocked_by"] {
  const unique = new Map(
    value.map((dependency) => [
      `${dependency.task}\0${dependency.type}\0${dependency.lag}`,
      { ...dependency },
    ]),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.task.localeCompare(right.task) ||
      left.type.localeCompare(right.type) ||
      left.lag - right.lag,
  );
}

export function mutationProjectFieldProjection(
  task: Task,
  config: Config,
): Record<string, unknown> {
  const mapping = config.sync.field_mapping;
  const fields: Record<string, unknown> = {
    [mapping.start_date]: task.start_date,
    [mapping.end_date]: task.end_date,
  };
  if (mapping.type) {
    fields[mapping.type] = config.task_types[task.type]?.github_field_value ?? null;
  }
  if (mapping.priority) {
    const value = task.custom_fields[mapping.priority];
    fields[mapping.priority] = typeof value === "string" ? value.toLowerCase() : null;
  }
  const estimateField = mapping.estimate_hours ?? DEFAULT_ESTIMATE_HOURS_FIELD;
  fields[estimateField] = parseEstimateHours(task.custom_fields[estimateField]);
  const statusField = config.statuses.field_name;
  const status = task.custom_fields[statusField];
  fields[statusField] = typeof status === "string" && status !== "" ? status : null;
  return Object.fromEntries(
    Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** create pushとreconcileが共有するremote postcondition。 */
export function createMutationRemoteProjection(
  task: Task,
  config: Config,
): Record<string, unknown> {
  return {
    state: task.state,
    state_reason: task.state_reason,
    title: task.title,
    body: serializeTaskBodyForGithub(task) ?? null,
    type: task.type,
    assignees: [...task.assignees].sort(),
    labels: [...task.labels].sort(),
    milestone: task.milestone,
    parent: task.parent,
    sub_tasks: [...task.sub_tasks],
    blocked_by: canonicalBlockedBy(task.blocked_by),
    project_fields: mutationProjectFieldProjection(task, config),
  };
}

/** non-create reconcileがlive Issue/relationshipと比較する正準before image。 */
export function mutationRemoteBeforeProjection(task: Task): Record<string, unknown> {
  return {
    state: task.state,
    state_reason: task.state_reason,
    title: task.title,
    body: serializeTaskBodyForGithub(task) ?? null,
    parent: task.parent,
    sub_tasks: [...task.sub_tasks],
    blocked_by: canonicalBlockedBy(task.blocked_by),
  };
}
