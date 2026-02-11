import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";

interface GanttMilestoneProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  showIssueId?: boolean;
}

export function GanttMilestone({ task, taskType, xScale, y, height, showIssueId }: GanttMilestoneProps) {
  const dateStr = task.date ?? task.start_date ?? task.end_date;
  if (!dateStr) return null;

  const x = xScale(parseDate(dateStr));
  const cy = y + height / 2;
  const size = 6;
  const color = taskType?.color ?? "#E74C3C";

  return (
    <g>
      <polygon
        points={`${x},${cy - size} ${x + size},${cy} ${x},${cy + size} ${x - size},${cy}`}
        fill={task.state === "closed" ? color : color + "66"}
        stroke={color}
        strokeWidth={1}
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
