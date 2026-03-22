import type { SyncFields } from "@gh-gantt/shared";

export const SYNC_FIELD_KEYS: (keyof SyncFields)[] = [
  "title",
  "body",
  "state",
  "type",
  "assignees",
  "labels",
  "milestone",
  "custom_fields",
  "parent",
  "sub_tasks",
  "start_date",
  "end_date",
  "date",
  "blocked_by",
];

export interface FieldConflict {
  field: string;
  base: unknown;
  current: unknown;
  incoming: unknown;
}

export interface MergeResult {
  merged: SyncFields;
  conflicts: FieldConflict[];
}

/**
 * Normalize a field value to a canonical JSON string for comparison.
 * - Arrays: sorted before stringify. `blocked_by` sorted by `.task`, others by string value.
 * - Objects (custom_fields): keys sorted before stringify.
 */
function normalizeForCompare(field: keyof SyncFields, value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const sorted = [...value].sort((a, b) => {
      // blocked_by: sort by .task property
      if (typeof a === "object" && a !== null && "task" in a) {
        return String((a as { task: string }).task).localeCompare(
          String((b as { task: string }).task),
        );
      }
      // string arrays (assignees, labels, sub_tasks): sort by string value
      return String(a).localeCompare(String(b));
    });
    return JSON.stringify(sorted);
  }

  if (typeof value === "object" && value !== null) {
    // custom_fields: sort keys
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (value as Record<string, unknown>)[key];
        return acc;
      }, {});
    return JSON.stringify(sorted);
  }

  return JSON.stringify(value);
}

/**
 * Three-way merge for SyncFields.
 *
 * For each field:
 * - base == current && base == incoming → no change (keep base)
 * - base == current && base != incoming → adopt incoming (remote-only)
 * - base != current && base == incoming → keep current (local-only)
 * - both changed, same value → keep current
 * - both changed, different values → conflict (keep current in merged)
 */
export function threeWayMerge(
  base: SyncFields,
  current: SyncFields,
  incoming: SyncFields,
): MergeResult {
  const merged = { ...current };
  const conflicts: FieldConflict[] = [];

  for (const field of SYNC_FIELD_KEYS) {
    const baseStr = normalizeForCompare(field, base[field]);
    const currentStr = normalizeForCompare(field, current[field]);
    const incomingStr = normalizeForCompare(field, incoming[field]);

    if (baseStr === currentStr && baseStr === incomingStr) {
      // No change
      continue;
    }

    if (baseStr === currentStr && baseStr !== incomingStr) {
      // Remote-only change → adopt incoming
      (merged as Record<string, unknown>)[field] = incoming[field];
      continue;
    }

    if (baseStr !== currentStr && baseStr === incomingStr) {
      // Local-only change → keep current (already in merged)
      continue;
    }

    if (currentStr === incomingStr) {
      // Both changed to the same value → keep current (already in merged)
      continue;
    }

    // Both changed to different values → conflict, keep current in merged
    conflicts.push({
      field,
      base: base[field],
      current: current[field],
      incoming: incoming[field],
    });
  }

  return { merged, conflicts };
}
