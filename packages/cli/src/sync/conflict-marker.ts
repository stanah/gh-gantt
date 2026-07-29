import { SYNC_FIELD_KEYS } from "@gh-gantt/shared";
import type { ConflictPolicy, Task } from "@gh-gantt/shared";
import type { FieldConflict } from "./three-way-merge.js";

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

export interface PolicyResolution {
  ours: Set<string>;
  theirs: Set<string>;
  unresolved: Set<string>;
}

/**
 * 検出済み marker に宣言的ポリシーを適用する。
 * manual・未定義は marker を保持する。marker 契約の対象は既知の SyncFields のみ。
 */
export function applyConflictPolicy(
  task: Record<string, unknown>,
  policy: ConflictPolicy,
  filterField?: string,
): PolicyResolution {
  const result: PolicyResolution = {
    ours: new Set(),
    theirs: new Set(),
    unresolved: new Set(),
  };

  for (const marker of detectMarkers(task)) {
    if (filterField !== undefined && marker.field !== filterField) {
      result.unresolved.add(marker.field);
      continue;
    }
    const choice = policy[marker.field as keyof ConflictPolicy];
    if (choice !== "ours" && choice !== "theirs") {
      result.unresolved.add(marker.field);
      continue;
    }
    resolveMarker(task, marker.field, choice);
    result[choice].add(marker.field);
  }

  return result;
}
