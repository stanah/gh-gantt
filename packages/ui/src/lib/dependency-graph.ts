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
): { path: string } | null {
  const from = taskPositions.get(edge.from);
  const to = taskPositions.get(edge.to);
  if (!from || !to) return null;

  const barPad = 4; // matches barY = y + 4 in GanttBar
  const gap = 12;

  const startX = (from.x1 + from.x2) / 2;
  const endX = to.x1;
  const endY = to.y + rowHeight / 2;

  let startY: number;
  let path: string;

  if (to.y > from.y) {
    // Target below: exit from bottom
    startY = from.y + rowHeight - barPad;
    if (startX <= endX) {
      // Clear: L-shape (1 bend)
      path = `M ${startX} ${startY} L ${startX} ${endY} L ${endX} ${endY}`;
    } else {
      // Overlapping: down through gap → left → down → right
      const midY = (from.y + rowHeight + to.y) / 2;
      const approachX = Math.min(from.x1, endX) - gap;
      path = [
        `M ${startX} ${startY}`,
        `L ${startX} ${midY}`,
        `L ${approachX} ${midY}`,
        `L ${approachX} ${endY}`,
        `L ${endX} ${endY}`,
      ].join(" ");
    }
  } else if (to.y < from.y) {
    // Target above: exit from top
    startY = from.y + barPad;
    if (startX <= endX) {
      // Clear: L-shape up (1 bend)
      path = `M ${startX} ${startY} L ${startX} ${endY} L ${endX} ${endY}`;
    } else {
      // Overlapping: up through gap → left → up → right
      const midY = (to.y + rowHeight + from.y) / 2;
      const approachX = Math.min(from.x1, endX) - gap;
      path = [
        `M ${startX} ${startY}`,
        `L ${startX} ${midY}`,
        `L ${approachX} ${midY}`,
        `L ${approachX} ${endY}`,
        `L ${endX} ${endY}`,
      ].join(" ");
    }
  } else {
    // Same row: exit bottom, route through gap between this row and the next
    startY = from.y + rowHeight - barPad;
    const midY = from.y + rowHeight;
    const approachX = Math.min(from.x1, endX) - gap;
    path = [
      `M ${startX} ${startY}`,
      `L ${startX} ${midY}`,
      `L ${approachX} ${midY}`,
      `L ${approachX} ${endY}`,
      `L ${endX} ${endY}`,
    ].join(" ");
  }

  return { path };
}
