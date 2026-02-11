import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { calculateSummaryDates } from "../lib/summary-calc.js";
import { parseDate } from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

interface GanttSummaryBarProps {
  task: Task;
  allTasks: Task[];
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  showIssueId?: boolean;
  isDimmed?: boolean;
  highlightType?: RelationType | null;
}

export function GanttSummaryBar({ task, allTasks, taskType, xScale, y, height, showIssueId, isDimmed, highlightType }: GanttSummaryBarProps) {
  const dates = calculateSummaryDates(task, allTasks);
  if (!dates) return null;

  const x1 = xScale(parseDate(dates.start));
  const endDate = parseDate(dates.end);
  endDate.setDate(endDate.getDate() + 1);
  const x2 = xScale(endDate);
  const width = Math.max(x2 - x1, 4);
  const baseColor = taskType?.color ?? "#8E44AD";
  const color = highlightType
    ? (highlightType === "parent" || highlightType === "child" ? "#8957e5" : "#e74c3c")
    : baseColor;
  const barY = y + height / 2 - 3;
  const progress = task._progress ?? 0;

  return (
    <g opacity={isDimmed ? 0.3 : 1}>
      {/* Summary bar (thin bracket style) */}
      <rect x={x1} y={barY} width={width} height={6} fill={color} opacity={0.6} rx={1} />
      {/* Progress overlay */}
      <rect x={x1} y={barY} width={width * (progress / 100)} height={6} fill={color} rx={1} />
      {/* Left bracket */}
      <rect x={x1} y={barY - 2} width={3} height={10} fill={color} />
      {/* Right bracket */}
      <rect x={x2 - 3} y={barY - 2} width={3} height={10} fill={color} />
      {showIssueId && (
        <text
          x={x2 + 4}
          y={barY + 9}
          fontSize={9}
          fill="#888"
          style={{ pointerEvents: "none" }}
        >
          {formatIssueId(task.id)}
        </text>
      )}
    </g>
  );
}
