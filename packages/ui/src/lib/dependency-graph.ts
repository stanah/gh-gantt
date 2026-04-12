// shared パッケージから re-export（detectCycles, buildDependencyEdges）
// UI 固有の getEdgeCoordinates のみこのファイルで定義
export { detectCycles, buildDependencyEdges } from "@gh-gantt/shared";
export type { DependencyEdge } from "@gh-gantt/shared";
import type { DependencyEdge } from "@gh-gantt/shared";

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
