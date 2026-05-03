import type { Config, StatusValue, Task } from "@gh-gantt/shared";

export function isInProgressTask(task: Task, config: Config): boolean {
  const statusName = readStatus(task, config);
  if (!statusName) return false;
  const status = config.statuses.values[statusName];
  if (!status) return isKnownWorkStatusName(statusName);
  return isWorkStatus(status);
}

export function readStatus(task: Task, config: Config): string | null {
  const value = task.custom_fields[config.statuses.field_name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isWorkStatus(status: StatusValue): boolean {
  if (status.done) return false;
  return (
    status.starts_work === true ||
    status.category === "in_progress" ||
    status.category === "in_review"
  );
}

function isKnownWorkStatusName(statusName: string): boolean {
  const normalized = statusName.trim().toLowerCase();
  return (
    normalized === "in progress" ||
    normalized === "in review" ||
    normalized === "active" ||
    normalized === "working"
  );
}
