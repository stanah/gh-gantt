import type { Task, Dependency } from "./types.js";

export interface DependencyEdge {
  from: string;
  to: string;
  type: Dependency["type"];
  lag: number;
}

export interface CriticalPathTaskTiming {
  taskId: string;
  durationDays: number;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  isCritical: boolean;
}

export interface CriticalPathResult {
  taskTimings: Record<string, CriticalPathTaskTiming>;
  criticalTaskIds: string[];
  criticalEdgeKeys: string[];
  projectDurationDays: number;
  cycles: string[][];
}

export function buildDependencyEdges(tasks: Task[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const task of tasks) {
    for (const dep of task.blocked_by) {
      edges.push({
        from: dep.task,
        to: task.id,
        type: dep.type,
        lag: dep.lag,
      });
    }
  }
  return edges;
}

export function dependencyEdgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function parseDateToUtcTime(value: string): number | null {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
}

function durationDays(task: Task): number | null {
  if (!task.start_date || !task.end_date) return null;
  const start = parseDateToUtcTime(task.start_date);
  const end = parseDateToUtcTime(task.end_date);
  if (start == null || end == null || end < start) return null;
  return Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function buildScheduledCycles(tasks: Task[], scheduledTaskIds: Set<string>): string[][] {
  const scheduledTasks = tasks
    .filter((task) => scheduledTaskIds.has(task.id))
    .map((task) => ({
      ...task,
      blocked_by: task.blocked_by.filter(
        (dep) => dep.type === "finish-to-start" && scheduledTaskIds.has(dep.task),
      ),
    }));
  return detectCycles(scheduledTasks);
}

/**
 * finish-to-start 依存を使って CPM の earliest/latest timing と total float を計算する。
 * 日付未設定タスクはガント上の期間を持たないため計算対象から除外する。
 */
export function calculateCriticalPath(tasks: Task[]): CriticalPathResult {
  const durations = new Map<string, number>();
  for (const task of tasks) {
    const duration = durationDays(task);
    if (duration != null) durations.set(task.id, duration);
  }

  const scheduledTaskIds = new Set(durations.keys());
  const cycles = buildScheduledCycles(tasks, scheduledTaskIds);
  if (cycles.length > 0) {
    return {
      taskTimings: {},
      criticalTaskIds: [],
      criticalEdgeKeys: [],
      projectDurationDays: 0,
      cycles,
    };
  }

  const successors = new Map<string, Array<{ to: string; lag: number }>>();
  const predecessors = new Map<string, Array<{ from: string; lag: number }>>();
  const indegree = new Map<string, number>();

  for (const taskId of scheduledTaskIds) {
    successors.set(taskId, []);
    predecessors.set(taskId, []);
    indegree.set(taskId, 0);
  }

  for (const task of tasks) {
    if (!scheduledTaskIds.has(task.id)) continue;
    for (const dep of task.blocked_by) {
      if (dep.type !== "finish-to-start") continue;
      if (!scheduledTaskIds.has(dep.task)) continue;
      const lag = dep.lag ?? 0;
      successors.get(dep.task)!.push({ to: task.id, lag });
      predecessors.get(task.id)!.push({ from: dep.task, lag });
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = [...scheduledTaskIds].filter((taskId) => (indegree.get(taskId) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const taskId = queue.shift()!;
    order.push(taskId);
    for (const edge of successors.get(taskId) ?? []) {
      const nextDegree = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, nextDegree);
      if (nextDegree === 0) {
        queue.push(edge.to);
        queue.sort();
      }
    }
  }

  if (order.length !== scheduledTaskIds.size) {
    return {
      taskTimings: {},
      criticalTaskIds: [],
      criticalEdgeKeys: [],
      projectDurationDays: 0,
      cycles: detectCycles(tasks),
    };
  }

  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  for (const taskId of order) {
    const start = Math.max(
      0,
      ...(predecessors.get(taskId) ?? []).map(
        (edge) => (earlyFinish.get(edge.from) ?? 0) + edge.lag,
      ),
    );
    earlyStart.set(taskId, start);
    earlyFinish.set(taskId, start + durations.get(taskId)!);
  }

  const projectDurationDays = Math.max(0, ...order.map((taskId) => earlyFinish.get(taskId) ?? 0));
  const lateFinish = new Map<string, number>();
  const lateStart = new Map<string, number>();

  for (const taskId of [...order].reverse()) {
    const outgoing = successors.get(taskId) ?? [];
    const finish =
      outgoing.length === 0
        ? projectDurationDays
        : Math.min(...outgoing.map((edge) => (lateStart.get(edge.to) ?? 0) - edge.lag));
    lateFinish.set(taskId, finish);
    lateStart.set(taskId, finish - durations.get(taskId)!);
  }

  const taskTimings: Record<string, CriticalPathTaskTiming> = {};
  for (const taskId of order) {
    const totalFloat = (lateStart.get(taskId) ?? 0) - (earlyStart.get(taskId) ?? 0);
    taskTimings[taskId] = {
      taskId,
      durationDays: durations.get(taskId)!,
      earlyStart: earlyStart.get(taskId) ?? 0,
      earlyFinish: earlyFinish.get(taskId) ?? 0,
      lateStart: lateStart.get(taskId) ?? 0,
      lateFinish: lateFinish.get(taskId) ?? 0,
      totalFloat,
      isCritical: totalFloat === 0,
    };
  }

  const criticalTaskIds = order.filter((taskId) => taskTimings[taskId]?.isCritical);
  const criticalEdgeKeys: string[] = [];
  for (const taskId of order) {
    for (const edge of successors.get(taskId) ?? []) {
      const from = taskTimings[taskId];
      const to = taskTimings[edge.to];
      if (!from?.isCritical || !to?.isCritical) continue;
      if (to.earlyStart === from.earlyFinish + edge.lag) {
        criticalEdgeKeys.push(dependencyEdgeKey(taskId, edge.to));
      }
    }
  }

  return {
    taskTimings,
    criticalTaskIds,
    criticalEdgeKeys,
    projectDurationDays,
    cycles: [],
  };
}

/**
 * タスクの依存関係グラフから循環を検出する。
 * 検出された各循環を構成するタスク ID の配列として返す。
 */
export function detectCycles(tasks: Task[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    if (!graph.has(task.id)) graph.set(task.id, []);
    for (const dep of task.blocked_by) {
      if (!graph.has(dep.task)) graph.set(dep.task, []);
      graph.get(dep.task)!.push(task.id);
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string) {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (inStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        cycles.push(path.slice(cycleStart));
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node);
  }

  return cycles;
}
