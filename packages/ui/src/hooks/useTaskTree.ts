import { useState, useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";
import { UNASSIGNED } from "./useTaskFilter.js";
import { NO_PRIORITY } from "../components/PriorityFilter.js";

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
  selectedAssignees?: string[];
  selectedPriorities?: string[];
  priorityFieldName?: string;
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

  const { hideClosed = false, selectedAssignee = null, selectedAssignees = [], selectedPriorities = [], priorityFieldName, searchQuery = "" } = filterOptions;

  const { scheduledTree, backlogTree } = useMemo(() => {
    const trimmedQuery = searchQuery.trim();
    const selectedTokens = (selectedAssignees.length > 0 ? selectedAssignees : (selectedAssignee ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0));
    const selectedSet = new Set(selectedTokens);
    const hasAssigneeFilter = selectedSet.size > 0;
    const includeUnassigned = selectedSet.has(UNASSIGNED);
    const selectedUsers = new Set([...selectedSet].filter((v) => v !== UNASSIGNED));

    const hasPriorityFilter = selectedPriorities.length > 0;
    const prioritySet = new Set(selectedPriorities);
    const includeNoPriority = prioritySet.has(NO_PRIORITY);

    const prefiltered = tasks.filter((t) => {
      if (!enabledTypes.has(t.type)) return false;
      if (hideClosed && t.state === "closed") return false;
      if (trimmedQuery && !matchesSearch(t, trimmedQuery)) return false;
      if (hasPriorityFilter && priorityFieldName) {
        const taskPriority = t.custom_fields[priorityFieldName] as string | undefined;
        const isContainer = CONTAINER_TYPES.has(t.type) || t.sub_tasks.length > 0;
        if (!isContainer) {
          if (!taskPriority) {
            if (!includeNoPriority) return false;
          } else if (!prioritySet.has(taskPriority.toLowerCase())) {
            return false;
          }
        }
      }
      return true;
    });

    const prefilteredMap = new Map(prefiltered.map((t) => [t.id, t]));

    const matchesAssigneeFilter = (task: Task): boolean => {
      if (!hasAssigneeFilter) return true;
      if (includeUnassigned && task.assignees.length === 0) return true;
      return task.assignees.some((a) => selectedUsers.has(a));
    };

    const keepMemo = new Map<string, boolean>();
    const keepTaskById = (taskId: string, path: Set<string>): boolean => {
      if (!hasAssigneeFilter) return prefilteredMap.has(taskId);
      if (keepMemo.has(taskId)) return keepMemo.get(taskId) ?? false;
      const task = prefilteredMap.get(taskId);
      if (!task) return false;
      if (path.has(taskId)) return false;

      path.add(taskId);
      const childIds = task.sub_tasks.filter((id) => prefilteredMap.has(id));
      const hasMatchedDescendant = childIds.some((id) => keepTaskById(id, path));
      path.delete(taskId);
      const isContainer = CONTAINER_TYPES.has(task.type) || childIds.length > 0;
      const keep = isContainer
        ? matchesAssigneeFilter(task) || hasMatchedDescendant
        : matchesAssigneeFilter(task);

      keepMemo.set(taskId, keep);
      return keep;
    };

    const filtered = hasAssigneeFilter
      ? prefiltered.filter((t) => keepTaskById(t.id, new Set()))
      : prefiltered;

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
  }, [tasks, enabledTypes, hideClosed, selectedAssignee, selectedAssignees, selectedPriorities, priorityFieldName, searchQuery]);

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
