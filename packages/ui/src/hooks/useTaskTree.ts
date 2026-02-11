import { useState, useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";

export interface TreeNode {
  task: Task;
  children: TreeNode[];
  depth: number;
}

function isBacklog(task: Task): boolean {
  return !task.start_date && !task.end_date && !task.date;
}

export function useTaskTree(tasks: Task[], enabledTypes: Set<string>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [backlogCollapsed, setBacklogCollapsed] = useState(true);

  const toggle = useCallback((taskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleBacklog = useCallback(() => {
    setBacklogCollapsed((prev) => !prev);
  }, []);

  const { scheduledTree, backlogTree } = useMemo(() => {
    const filtered = tasks.filter((t) => enabledTypes.has(t.type));

    const scheduledTasks = filtered.filter((t) => !isBacklog(t));
    const backlogTasks = filtered.filter((t) => isBacklog(t));

    const buildTree = (subset: Task[]) => {
      const taskMap = new Map(subset.map((t) => [t.id, t]));

      const buildNode = (task: Task, depth: number): TreeNode => ({
        task,
        children: task.sub_tasks
          .map((id) => taskMap.get(id))
          .filter((t): t is Task => t != null && enabledTypes.has(t.type))
          .map((child) => buildNode(child, depth + 1)),
        depth,
      });

      const roots = subset.filter((t) => !t.parent || !taskMap.has(t.parent));
      return roots.map((t) => buildNode(t, 0));
    };

    return {
      scheduledTree: buildTree(scheduledTasks),
      backlogTree: buildTree(backlogTasks),
    };
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
    flatten(scheduledTree);
    return result;
  }, [scheduledTree, collapsed]);

  const backlogFlatList = useMemo(() => {
    const result: TreeNode[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (!collapsed.has(node.task.id) && node.children.length > 0) {
          flatten(node.children);
        }
      }
    };
    flatten(backlogTree);
    return result;
  }, [backlogTree, collapsed]);

  const backlogTotalCount = useMemo(() => {
    let count = 0;
    const countNodes = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        count++;
        countNodes(node.children);
      }
    };
    countNodes(backlogTree);
    return count;
  }, [backlogTree]);

  return {
    tree: scheduledTree,
    flatList,
    collapsed,
    toggle,
    backlogFlatList,
    backlogCollapsed,
    backlogTotalCount,
    toggleBacklog,
  };
}
