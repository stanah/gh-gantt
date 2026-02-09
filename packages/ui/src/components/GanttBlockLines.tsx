import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import type { Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import { buildDependencyEdges, detectCycles, getEdgeCoordinates } from "../lib/dependency-graph.js";
import { parseDate } from "../lib/date-utils.js";
import { ROW_HEIGHT } from "./TaskTree.js";

interface GanttBlockLinesProps {
  tasks: Task[];
  flatList: TreeNode[];
  xScale: ScaleTime<number, number>;
  totalWidth: number;
  totalHeight: number;
}

export function GanttBlockLines({ tasks, flatList, xScale, totalWidth, totalHeight }: GanttBlockLinesProps) {
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

  if (edges.length === 0) return null;

  return (
    <svg
      width={totalWidth}
      height={totalHeight}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
    >
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#666" />
        </marker>
        <marker id="arrowhead-red" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#E74C3C" />
        </marker>
      </defs>
      {edges.map((edge, i) => {
        const coords = getEdgeCoordinates(edge, taskPositions, ROW_HEIGHT);
        if (!coords) return null;

        const isCycleEdge = cycles.has(edge.from) && cycles.has(edge.to);

        return (
          <path
            key={i}
            d={coords.path}
            fill="none"
            stroke={isCycleEdge ? "#E74C3C" : "#666"}
            strokeWidth={1.5}
            strokeDasharray={edge.lag > 0 ? "4 2" : undefined}
            markerEnd={isCycleEdge ? "url(#arrowhead-red)" : "url(#arrowhead)"}
            opacity={0.7}
          />
        );
      })}
    </svg>
  );
}
