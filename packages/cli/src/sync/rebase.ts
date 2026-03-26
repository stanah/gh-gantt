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

  // Re-resolve type using current config
  const type = resolveTaskType(
    syncFields.labels,
    syncFields.custom_fields as Record<string, unknown>,
    config.task_types,
    fm.type,
  );

  // Re-resolve start_date/end_date from custom_fields using current field_mapping
  const start_date = (syncFields.custom_fields[fm.start_date] as string) ?? syncFields.start_date;
  const end_date = (syncFields.custom_fields[fm.end_date] as string) ?? syncFields.end_date;

  return {
    ...syncFields,
    type,
    start_date,
    end_date,
  };
}
