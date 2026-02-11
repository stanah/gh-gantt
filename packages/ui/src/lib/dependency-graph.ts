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
  const barPad = 4;  // matches barY = y + 4 in GanttBar
  const gap = 8;

  // Start: side of from bar at vertical center
  const isFromEnd = edge.type === "finish-to-start" || edge.type === "finish-to-finish";
  const startX = isFromEnd ? from.x2 : from.x1;
  const startY = from.y + midY;

  // End: top of to bar at the appropriate side
  const isToStart = edge.type === "finish-to-start" || edge.type === "start-to-start";
  const endX = isToStart ? to.x1 : to.x2;
  const endY = to.y + barPad;

  // Polyline routing:
  // 1. Step away horizontally from the from bar
  // 2. Go vertically to just above the target bar
  // 3. Go horizontally to above the endpoint
  // 4. Go down vertically into the top of the bar
  const turnX = isFromEnd ? startX + gap : startX - gap;
  const aboveY = endY - gap;

  const path = [
    `M ${startX} ${startY}`,
    `L ${turnX} ${startY}`,
    `L ${turnX} ${aboveY}`,
    `L ${endX} ${aboveY}`,
    `L ${endX} ${endY}`,
  ].join(" ");

  return { path, isCycle: false };
}
