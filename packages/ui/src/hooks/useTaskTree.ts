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

export interface TaskFilterOptions {
  hideClosed?: boolean;
  selectedAssignee?: string | null;
  searchQuery?: string;
}

const CONTAINER_TYPES = new Set(["epic", "summary"]);

function matchesSearch(task: Task, query: string): boolean {
  const q = query.toLowerCase();
  if (task.title.toLowerCase().includes(q)) return true;
  if (task.body?.toLowerCase().includes(q)) return true;
  if (task.id.toLowerCase().includes(q)) return true;
  if (task.type.toLowerCase().includes(q)) return true;
  if (task.state.toLowerCase().includes(q)) return true;
  if (task.milestone?.toLowerCase().includes(q)) return true;
  if (task.labels.some((l) => l.toLowerCase().includes(q))) return true;
  if (task.assignees.some((a) => a.toLowerCase().includes(q))) return true;
  if (task.github_issue != null && String(task.github_issue).includes(q)) return true;
  for (const v of Object.values(task.custom_fields)) {
    if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
  }
  return false;
}

export function useTaskTree(tasks: Task[], enabledTypes: Set<string>, filterOptions: TaskFilterOptions = {}) {
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

  const { hideClosed = false, selectedAssignee = null, searchQuery = "" } = filterOptions;

  const { scheduledTree, backlogTree } = useMemo(() => {
    const trimmedQuery = searchQuery.trim();
    const filtered = tasks.filter((t) => {
      if (!enabledTypes.has(t.type)) return false;
      if (hideClosed && t.state === "closed") return false;
      if (selectedAssignee && !CONTAINER_TYPES.has(t.type)) {
        if (selectedAssignee === "__unassigned__") {
          if (t.assignees.length > 0) return false;
        } else {
          if (!t.assignees.includes(selectedAssignee)) return false;
        }
      }
      if (trimmedQuery && !matchesSearch(t, trimmedQuery)) return false;
      return true;
    });

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
      roots.sort((a, b) => {
        const aMs = a.type === "milestone" ? 1 : 0;
        const bMs = b.type === "milestone" ? 1 : 0;
        return aMs - bMs;
      });
      return roots.map((t) => buildNode(t, 0));
    };

    return {
      scheduledTree: buildTree(scheduledTasks),
      backlogTree: buildTree(backlogTasks),
    };
  }, [tasks, enabledTypes, hideClosed, selectedAssignee, searchQuery]);

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
