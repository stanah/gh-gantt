import type { Task, Dependency } from "../types/index.js";

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

export function getEdgeCoordinates(
  edge: DependencyEdge,
  taskPositions: Map<string, { x1: number; x2: number; y: number }>,
  rowHeight: number,
): { path: string; isCycle: boolean } | null {
  const from = taskPositions.get(edge.from);
  const to = taskPositions.get(edge.to);
  if (!from || !to) return null;

  const midY = rowHeight / 2;

  let startX: number;
  let endX: number;

  switch (edge.type) {
    case "finish-to-start":
      startX = from.x2;
      endX = to.x1;
      break;
    case "finish-to-finish":
      startX = from.x2;
      endX = to.x2;
      break;
    case "start-to-start":
      startX = from.x1;
      endX = to.x1;
      break;
    case "start-to-finish":
      startX = from.x1;
      endX = to.x2;
      break;
  }

  const fromY = from.y + midY;
  const toY = to.y + midY;

  // Simple path with a bend
  const bendX = startX + (endX - startX) * 0.5;
  const path = `M ${startX} ${fromY} C ${bendX} ${fromY}, ${bendX} ${toY}, ${endX} ${toY}`;

  return { path, isCycle: false };
}
