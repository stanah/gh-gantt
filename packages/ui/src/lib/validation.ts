import type { Task } from "../types/index.js";

/**
 * Check if setting newParentId as parent of childId would create a cycle.
 * Walks up the parent chain from newParentId; if it reaches childId, it's a cycle.
 */
export function wouldCreateParentCycle(
  tasks: Task[],
  childId: string,
  newParentId: string,
): boolean {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  let current = newParentId;
  while (current) {
    if (current === childId) return true;
    const task = taskMap.get(current);
    if (!task?.parent) break;
    current = task.parent;
  }
  return false;
}

/**
 * Check if placing childType under parentType is allowed by type_hierarchy config.
 * Missing key or empty array → no restriction (all child types allowed).
 * Non-empty array → whitelist of allowed child types.
 */
export function isTypeHierarchyAllowed(
  typeHierarchy: Record<string, string[]>,
  parentType: string,
  childType: string,
): boolean {
  const allowed = typeHierarchy[parentType];
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(childType);
}
