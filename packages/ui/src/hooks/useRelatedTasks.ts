import { useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";

export type RelationType = "parent" | "child" | "blocker" | "blocked";

interface RelatedResult {
  ids: Set<string>;
  relationMap: Map<string, RelationType>;
}

const EMPTY: RelatedResult = { ids: new Set(), relationMap: new Map() };

export function useRelatedTasks(tasks: Task[]) {
  // Build reverse index: taskId -> set of tasks that this task blocks (i.e. tasks whose blocked_by includes this task)
  const blocksIndex = useMemo(() => {
    const index = new Map<string, Set<string>>();
    for (const task of tasks) {
      for (const dep of task.blocked_by) {
        let set = index.get(dep.task);
        if (!set) {
          set = new Set();
          index.set(dep.task, set);
        }
        set.add(task.id);
      }
    }
    return index;
  }, [tasks]);

  const taskMap = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const getRelated = useCallback(
    (hoveredId: string | null): RelatedResult => {
      if (!hoveredId) return EMPTY;
      const task = taskMap.get(hoveredId);
      if (!task) return EMPTY;

      const ids = new Set<string>();
      const relationMap = new Map<string, RelationType>();

      // Parent
      if (task.parent) {
        ids.add(task.parent);
        relationMap.set(task.parent, "parent");
      }

      // Children
      for (const childId of task.sub_tasks) {
        ids.add(childId);
        relationMap.set(childId, "child");
      }

      // Blockers (tasks that block this one)
      for (const dep of task.blocked_by) {
        ids.add(dep.task);
        relationMap.set(dep.task, "blocker");
      }

      // Blocked (tasks that this one blocks)
      const blockedTasks = blocksIndex.get(hoveredId);
      if (blockedTasks) {
        for (const blockedId of blockedTasks) {
          if (!relationMap.has(blockedId)) {
            ids.add(blockedId);
            relationMap.set(blockedId, "blocked");
          }
        }
      }

      return { ids, relationMap };
    },
    [taskMap, blocksIndex],
  );

  return { getRelated };
}
