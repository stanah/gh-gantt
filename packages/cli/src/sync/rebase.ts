import type { SyncFields, Config } from "@gh-gantt/shared";
import { resolveTaskType } from "./type-resolver.js";

/**
 * Re-resolve config-dependent fields in a snapshot's syncFields
 * using the current config. This prevents false diffs when config
 * changes between syncs.
 *
 * Fields re-resolved:
 * - type: re-resolved from labels/custom_fields + current task_types
 * - start_date/end_date: re-extracted from custom_fields + current field_mapping
 */
export function rebaseSyncFields(syncFields: SyncFields, config: Config): SyncFields {
  const fm = config.sync.field_mapping;

  // Re-resolve type using current config.
  // If any task_type uses github_issue_type, skip re-resolution because
  // issue type info is not available in SyncFields and re-resolving would
  // incorrectly fall back to "task".
  const usesIssueTypes = Object.values(config.task_types).some((t) => t.github_issue_type);
  const type = usesIssueTypes
    ? syncFields.type
    : resolveTaskType(syncFields.labels, syncFields.custom_fields, config.task_types, fm.type);

  // Re-resolve start_date/end_date from custom_fields using current field_mapping
  const rawStartDate = syncFields.custom_fields[fm.start_date];
  const rawEndDate = syncFields.custom_fields[fm.end_date];
  const start_date = typeof rawStartDate === "string" ? rawStartDate : syncFields.start_date;
  const end_date = typeof rawEndDate === "string" ? rawEndDate : syncFields.end_date;

  return {
    ...syncFields,
    type,
    start_date,
    end_date,
  };
}
