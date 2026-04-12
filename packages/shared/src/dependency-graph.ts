import type { Task, Dependency } from "./types.js";

export interface DependencyEdge {
  from: string;
  to: string;
  type: Dependency["type"];
  lag: number;
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
