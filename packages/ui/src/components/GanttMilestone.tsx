import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

interface GanttMilestoneProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  showIssueId?: boolean;
  isDimmed?: boolean;
  highlightType?: RelationType | null;
}

export function GanttMilestone({ task, taskType, xScale, y, height, showIssueId, isDimmed, highlightType }: GanttMilestoneProps) {
  const dateStr = task.date ?? task.start_date ?? task.end_date;
  if (!dateStr) return null;

  const x = xScale(parseDate(dateStr));
  const cy = y + height / 2;
  const size = 6;
  const color = taskType?.color ?? "#E74C3C";

  const hlStroke = highlightType
    ? (highlightType === "parent" || highlightType === "child" ? "#8957e5" : "#e74c3c")
    : color;

  return (
    <g opacity={isDimmed ? 0.3 : 1}>
      <polygon
        points={`${x},${cy - size} ${x + size},${cy} ${x},${cy + size} ${x - size},${cy}`}
        fill={task.state === "closed" ? color : color + "66"}
        stroke={highlightType ? hlStroke : color}
        strokeWidth={highlightType ? 2 : 1}
      />
      {showIssueId && (
        <text
          x={x + size + 4}
          y={cy + 4}
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
