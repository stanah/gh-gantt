import type { Task } from "@gh-gantt/shared";
import { SYNC_FIELD_KEYS, type FieldConflict } from "./three-way-merge.js";

const SYNC_FIELD_KEY_SET: Set<string> = new Set(SYNC_FIELD_KEYS);

/**
 * Write conflict markers to task data.
 * Spreads the task and adds {field}_current and {field}_incoming for each conflict.
 * The original field keeps the current (local) value.
 */
export function applyConflictMarkers(
  task: Task,
  conflicts: FieldConflict[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...task };

  for (const conflict of conflicts) {
    result[`${conflict.field}_current`] = conflict.current;
    result[`${conflict.field}_incoming`] = conflict.incoming;
  }

  return result;
}

/**
 * Detect conflict markers from task data.
 * Scans for keys ending in _current, checks matching _incoming exists.
 * Only considers SyncFields keys; ignores orphaned/non-SyncFields markers.
 * base is set to undefined (retrieved from snapshot externally).
 */
export function detectMarkers(task: Record<string, unknown>): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  for (const key of Object.keys(task)) {
    if (!key.endsWith("_current")) continue;

    const field = key.slice(0, -"_current".length);
    if (!SYNC_FIELD_KEY_SET.has(field)) continue;

    const incomingKey = `${field}_incoming`;
    if (!(incomingKey in task)) continue;

    conflicts.push({
      field,
      base: undefined,
      current: task[key],
      incoming: task[incomingKey],
    });
  }

  return conflicts;
}

/**
 * Resolve a conflict marker.
 * "ours" keeps the current value; "theirs" adopts the incoming value.
 * Both choices remove the marker keys.
 */
export function resolveMarker(
  task: Record<string, unknown>,
  field: string,
  choice: "ours" | "theirs",
): void {
  const currentKey = `${field}_current`;
  const incomingKey = `${field}_incoming`;

  if (choice === "theirs") {
    task[field] = task[incomingKey];
  }

  delete task[currentKey];
  delete task[incomingKey];
}

/**
 * Check if task has unresolved conflict markers.
 */
export function hasUnresolvedMarkers(task: Record<string, unknown>): boolean {
  return detectMarkers(task).length > 0;
}
