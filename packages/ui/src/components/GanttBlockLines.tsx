import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import {
  buildDependencyEdges,
  dependencyEdgeKey,
  detectCycles,
  getEdgeCoordinates,
} from "../lib/dependency-graph.js";
import { parseDate } from "../lib/date-utils.js";
import { ROW_HEIGHT } from "./TaskTree.js";

interface GanttBlockLinesProps {
  tasks: Task[];
  flatList: TreeNode[];
  xScale: ScaleTime<number, number>;
  totalWidth: number;
  totalHeight: number;
  hoveredTaskId: string | null;
  criticalEdgeKeys?: Set<string>;
  criticalPathColor?: string;
}

export function GanttBlockLines({
  tasks,
  flatList,
  xScale,
  totalWidth,
  totalHeight,
  hoveredTaskId,
  criticalEdgeKeys,
  criticalPathColor = "var(--color-danger)",
}: GanttBlockLinesProps) {
  const edges = useMemo(() => buildDependencyEdges(tasks), [tasks]);
  const cycles = useMemo(() => {
    const c = detectCycles(tasks);
    const cycleNodes = new Set(c.flat());
    return cycleNodes;
  }, [tasks]);

  const taskPositions = useMemo(() => {
    const map = new Map<string, { x1: number; x2: number; y: number }>();
    flatList.forEach((node, i) => {
      const task = node.task;
      if (task.start_date && task.end_date) {
        const x1 = xScale(parseDate(task.start_date));
        const endDate = parseDate(task.end_date);
        endDate.setDate(endDate.getDate() + 1);
        const x2 = xScale(endDate);
        map.set(task.id, { x1, x2, y: i * ROW_HEIGHT });
      }
    });
    return map;
  }, [flatList, xScale]);

  // ホバー対象の依存線に加え、critical path 上の依存線は常時表示する。
  const visibleEdges = useMemo(() => {
    return edges.filter((edge) => {
      const isCriticalEdge = criticalEdgeKeys?.has(dependencyEdgeKey(edge.from, edge.to)) ?? false;
      if (isCriticalEdge) return true;
      return hoveredTaskId != null && (edge.from === hoveredTaskId || edge.to === hoveredTaskId);
    });
  }, [criticalEdgeKeys, edges, hoveredTaskId]);

  if (visibleEdges.length === 0) return null;

  return (
    <svg
      width={totalWidth}
      height={totalHeight}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      aria-hidden="true"
    >
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--color-text-secondary)" />
        </marker>
        <marker id="arrowhead-red" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="var(--color-danger)" />
        </marker>
        <marker
          id="arrowhead-critical"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
        >
          <polygon points="0 0, 8 3, 0 6" fill={criticalPathColor} />
        </marker>
      </defs>
      {visibleEdges.map((edge, i) => {
        const coords = getEdgeCoordinates(edge, taskPositions, ROW_HEIGHT);
        if (!coords) return null;

        const isCycleEdge = cycles.has(edge.from) && cycles.has(edge.to);
        const isCriticalEdge =
          criticalEdgeKeys?.has(dependencyEdgeKey(edge.from, edge.to)) ?? false;

        return (
          <path
            key={i}
            data-critical-path={isCriticalEdge ? "true" : undefined}
            d={coords.path}
            fill="none"
            stroke={
              isCycleEdge
                ? "var(--color-danger)"
                : isCriticalEdge
                  ? criticalPathColor
                  : "var(--color-text-secondary)"
            }
            strokeWidth={isCriticalEdge ? 2.5 : 1.5}
            strokeDasharray={edge.lag > 0 ? "4 2" : undefined}
            markerEnd={
              isCycleEdge
                ? "url(#arrowhead-red)"
                : isCriticalEdge
                  ? "url(#arrowhead-critical)"
                  : "url(#arrowhead)"
            }
            opacity={isCriticalEdge ? 0.95 : 0.7}
          />
        );
      })}
    </svg>
  );
}
