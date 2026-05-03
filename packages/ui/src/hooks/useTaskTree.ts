import { useState, useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";
import { UNASSIGNED, NO_PRIORITY, NO_LABEL } from "./useTaskFilter.js";

export interface TreeNode {
  task: Task;
  children: TreeNode[];
  depth: number;
  scheduleState?: ScheduleState;
  renderKey?: string;
  kind?: "task" | "group";
  group?: {
    label: string;
    taskCount: number;
  };
}

export type TaskSortMode = "default" | "updated_at_asc" | "updated_at_desc";
export type ScheduleState = "scheduled" | "unscheduled_child" | "unscheduled_root";

export interface LabelGroupingOptions {
  enabled: boolean;
  labelPrefix?: string;
  otherLabel?: string;
}

export interface TaskFilterOptions {
  hideClosed?: boolean;
  selectedAssignee?: string | null;
  selectedAssignees?: string[];
  selectedPriorities?: string[];
  priorityFieldName?: string;
  selectedLabels?: string[];
  searchQuery?: string;
  taskSortMode?: TaskSortMode;
  labelGrouping?: LabelGroupingOptions;
}

const CONTAINER_TYPES = new Set(["epic", "summary"]);
const GROUP_NODE_TYPE = "__label_group__";
const DEFAULT_OTHER_GROUP_LABEL = "その他";

function compareUpdatedAt(
  a: Task,
  b: Task,
  sortMode: TaskSortMode,
  updatedAtTimestamps?: Map<string, number>,
): number {
  if (sortMode === "default") return 0;

  const aTime = updatedAtTimestamps?.get(a.id) ?? Number.NaN;
  const bTime = updatedAtTimestamps?.get(b.id) ?? Number.NaN;
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;

  const cmp = aTime - bTime;
  return sortMode === "updated_at_desc" ? -cmp : cmp;
}

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

function makeGroupTask(label: string, taskCount: number): Task {
  return {
    id: `${GROUP_NODE_TYPE}:${label}`,
    type: GROUP_NODE_TYPE,
    github_issue: null,
    github_repo: "",
    parent: null,
    sub_tasks: [],
    title: label,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: label === DEFAULT_OTHER_GROUP_LABEL ? [] : [label],
    milestone: null,
    linked_prs: [],
    created_at: "",
    updated_at: "",
    closed_at: null,
    custom_fields: { taskCount },
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
  };
}

function getGroupingLabels(task: Task, labelPrefix: string, otherLabel: string): string[] {
  const matchingLabels = task.labels.filter((label) => label.startsWith(labelPrefix)).sort();
  return matchingLabels.length > 0 ? matchingLabels : [otherLabel];
}

function collectGroupLabels(nodes: TreeNode[], labelPrefix: string, otherLabel: string): string[] {
  const labels = new Set<string>();
  const visit = (node: TreeNode) => {
    for (const label of getGroupingLabels(node.task, labelPrefix, otherLabel)) {
      labels.add(label);
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return [...labels].sort((a, b) => {
    if (a === otherLabel && b !== otherLabel) return 1;
    if (b === otherLabel && a !== otherLabel) return -1;
    return a.localeCompare(b);
  });
}

function countTaskNodes(nodes: TreeNode[]): number {
  let count = 0;
  const visit = (node: TreeNode) => {
    if (node.kind !== "group") count++;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return count;
}

function hasSchedule(task: Task): boolean {
  return Boolean(task.start_date || task.end_date || task.date);
}

function getScheduleState(task: Task, visibleTaskById: Map<string, Task>): ScheduleState {
  if (hasSchedule(task)) return "scheduled";
  return task.parent && visibleTaskById.has(task.parent) ? "unscheduled_child" : "unscheduled_root";
}

function cloneForGroup(
  node: TreeNode,
  groupLabel: string,
  labelPrefix: string,
  otherLabel: string,
  depth: number,
): TreeNode | null {
  const ownLabels = getGroupingLabels(node.task, labelPrefix, otherLabel);
  const childClones = node.children
    .map((child) => cloneForGroup(child, groupLabel, labelPrefix, otherLabel, depth + 1))
    .filter((child): child is TreeNode => child != null);
  if (!ownLabels.includes(groupLabel) && childClones.length === 0) return null;

  return {
    ...node,
    depth,
    renderKey: `${groupLabel}:${node.task.id}`,
    children: childClones,
  };
}

function groupTreeByLabel(
  roots: TreeNode[],
  labelPrefix: string,
  otherLabel = DEFAULT_OTHER_GROUP_LABEL,
): TreeNode[] {
  const labels = collectGroupLabels(roots, labelPrefix, otherLabel);
  return labels.flatMap((label) => {
    const children = roots
      .map((root) => cloneForGroup(root, label, labelPrefix, otherLabel, 1))
      .filter((node): node is TreeNode => node != null);
    if (children.length === 0) return [];
    const taskCount = countTaskNodes(children);
    return [
      {
        task: makeGroupTask(label, taskCount),
        children,
        depth: 0,
        renderKey: `${GROUP_NODE_TYPE}:${label}`,
        kind: "group" as const,
        group: { label, taskCount },
      },
    ];
  });
}

export function useTaskTree(
  tasks: Task[],
  enabledTypes: Set<string>,
  filterOptions: TaskFilterOptions = {},
) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((taskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const {
    hideClosed = false,
    selectedAssignee = null,
    selectedAssignees = [],
    selectedPriorities = [],
    priorityFieldName,
    selectedLabels = [],
    searchQuery = "",
    taskSortMode = "default",
    labelGrouping,
  } = filterOptions;

  const tree = useMemo(() => {
    const trimmedQuery = searchQuery.trim();
    const selectedTokens =
      selectedAssignees.length > 0
        ? selectedAssignees
        : (selectedAssignee ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    const selectedSet = new Set(selectedTokens);
    const hasAssigneeFilter = selectedSet.size > 0;
    const includeUnassigned = selectedSet.has(UNASSIGNED);
    const selectedUsers = new Set([...selectedSet].filter((v) => v !== UNASSIGNED));

    const hasPriorityFilter = selectedPriorities.length > 0;
    const prioritySet = new Set(selectedPriorities);
    const includeNoPriority = prioritySet.has(NO_PRIORITY);

    const taskById = new Map(tasks.map((t) => [t.id, t]));

    const matchesPriorityOwn = (t: Task): boolean => {
      if (!hasPriorityFilter || !priorityFieldName) return true;
      const rawPriority = t.custom_fields[priorityFieldName];
      const taskPriority = typeof rawPriority === "string" ? rawPriority : undefined;
      if (!taskPriority) return includeNoPriority;
      return prioritySet.has(taskPriority.toLowerCase());
    };

    const passesBaseFilters = (t: Task): boolean => {
      if (!enabledTypes.has(t.type)) return false;
      if (hideClosed && t.state === "closed") return false;
      if (trimmedQuery && !matchesSearch(t, trimmedQuery)) return false;
      return true;
    };

    const priorityKeepMemo = new Map<string, boolean>();
    const keepByPriority = (taskId: string, seen: Set<string>): boolean => {
      if (priorityKeepMemo.has(taskId)) return priorityKeepMemo.get(taskId)!;
      const t = taskById.get(taskId);
      if (!t || !passesBaseFilters(t)) return false;
      if (seen.has(taskId)) return false;
      seen.add(taskId);

      const isContainer = CONTAINER_TYPES.has(t.type) || t.sub_tasks.length > 0;
      if (!isContainer) {
        const result = matchesPriorityOwn(t);
        priorityKeepMemo.set(taskId, result);
        return result;
      }

      if (matchesPriorityOwn(t)) {
        priorityKeepMemo.set(taskId, true);
        return true;
      }

      const hasMatchingDescendant = t.sub_tasks.some((id) => keepByPriority(id, seen));
      priorityKeepMemo.set(taskId, hasMatchingDescendant);
      return hasMatchingDescendant;
    };

    const prefiltered = tasks.filter((t) => {
      if (!passesBaseFilters(t)) return false;
      if (hasPriorityFilter && priorityFieldName) {
        return keepByPriority(t.id, new Set());
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

    const afterAssignee = hasAssigneeFilter
      ? prefiltered.filter((t) => keepTaskById(t.id, new Set()))
      : prefiltered;

    // --- Label filter ---
    const hasLabelFilter = selectedLabels.length > 0;
    const labelSet = new Set(selectedLabels);
    const includeNoLabel = labelSet.has(NO_LABEL);
    const selectedLabelNames = new Set([...labelSet].filter((v) => v !== NO_LABEL));

    const matchesLabelOwn = (task: Task): boolean => {
      if (!hasLabelFilter) return true;
      if (includeNoLabel && task.labels.length === 0) return true;
      return task.labels.some((l) => selectedLabelNames.has(l));
    };

    const afterAssigneeMap = new Map(afterAssignee.map((t) => [t.id, t]));
    const labelKeepMemo = new Map<string, boolean>();
    const keepByLabel = (taskId: string, path: Set<string>): boolean => {
      if (labelKeepMemo.has(taskId)) return labelKeepMemo.get(taskId)!;
      const task = afterAssigneeMap.get(taskId);
      if (!task) return false;
      if (path.has(taskId)) return false;
      path.add(taskId);

      const childIds = task.sub_tasks.filter((id) => afterAssigneeMap.has(id));
      const hasMatchedDescendant = childIds.some((id) => keepByLabel(id, path));
      path.delete(taskId);
      const isContainer = CONTAINER_TYPES.has(task.type) || childIds.length > 0;
      const keep = isContainer
        ? matchesLabelOwn(task) || hasMatchedDescendant
        : matchesLabelOwn(task);

      labelKeepMemo.set(taskId, keep);
      return keep;
    };

    const filtered = hasLabelFilter
      ? afterAssignee.filter((t) => keepByLabel(t.id, new Set()))
      : afterAssignee;

    const taskMap = new Map(filtered.map((t) => [t.id, t]));
    const updatedAtTimestamps =
      taskSortMode === "default"
        ? undefined
        : new Map(filtered.map((t) => [t.id, Date.parse(t.updated_at)]));

    const sortTaskList = (items: Task[]): Task[] => {
      if (taskSortMode === "default") return items;
      return [...items].sort((a, b) => compareUpdatedAt(a, b, taskSortMode, updatedAtTimestamps));
    };

    const buildNode = (task: Task, depth: number): TreeNode => ({
      task,
      renderKey: task.id,
      scheduleState: getScheduleState(task, taskMap),
      children: sortTaskList(
        task.sub_tasks
          .map((id) => taskMap.get(id))
          .filter((t): t is Task => t != null && enabledTypes.has(t.type)),
      ).map((child) => buildNode(child, depth + 1)),
      depth,
    });

    const roots = filtered.filter((t) => !t.parent || !taskMap.has(t.parent));
    roots.sort((a, b) => {
      const aMs = a.type === "milestone" ? 1 : 0;
      const bMs = b.type === "milestone" ? 1 : 0;
      const milestoneCmp = aMs - bMs;
      if (milestoneCmp !== 0) return milestoneCmp;
      return compareUpdatedAt(a, b, taskSortMode, updatedAtTimestamps);
    });
    const baseRoots = roots.map((t) => buildNode(t, 0));
    const labelPrefix = labelGrouping?.labelPrefix?.trim();
    if (labelGrouping?.enabled && labelPrefix) {
      return groupTreeByLabel(baseRoots, labelPrefix, labelGrouping.otherLabel);
    }
    return baseRoots;
  }, [
    tasks,
    enabledTypes,
    hideClosed,
    selectedAssignee,
    selectedAssignees,
    selectedPriorities,
    priorityFieldName,
    selectedLabels,
    searchQuery,
    taskSortMode,
    labelGrouping,
  ]);

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

  return {
    tree,
    flatList,
    collapsed,
    toggle,
  };
}
