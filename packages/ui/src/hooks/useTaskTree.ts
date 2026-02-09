import { useState, useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";

export interface TreeNode {
  task: Task;
  children: TreeNode[];
  depth: number;
}

export function useTaskTree(tasks: Task[], enabledTypes: Set<string>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = useCallback((taskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const tree = useMemo(() => {
    const filtered = tasks.filter((t) => enabledTypes.has(t.type));
    const taskMap = new Map(filtered.map((t) => [t.id, t]));

    const buildNode = (task: Task, depth: number): TreeNode => ({
      task,
      children: task.sub_tasks
        .map((id) => taskMap.get(id))
        .filter((t): t is Task => t != null && enabledTypes.has(t.type))
        .map((child) => buildNode(child, depth + 1)),
      depth,
    });

    // Root tasks: no parent, or parent not in our filtered set
    const roots = filtered.filter((t) => !t.parent || !taskMap.has(t.parent));
    return roots.map((t) => buildNode(t, 0));
  }, [tasks, enabledTypes]);

  const flatList = useMemo(() => {
    const result: TreeNode[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (!collapsed.has(node.task.id) && node.children.length > 0) {
          flatten(node.children);
        }
      }
    };
    flatten(tree);
    return result;
  }, [tree, collapsed]);

  return { tree, flatList, collapsed, toggle };
}
