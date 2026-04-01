import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import { isFriendlyRelation, type RelationType } from "../hooks/useRelatedTasks.js";

interface GanttMilestoneProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  showIssueId?: boolean;
  isDimmed?: boolean;
  highlightType?: RelationType | null;
  onTooltipShow?: (task: Task, e: React.MouseEvent | React.FocusEvent) => void;
  onTooltipHide?: () => void;
}

export function GanttMilestone({
  task,
  taskType,
  xScale,
  y,
  height,
  showIssueId,
  isDimmed,
  highlightType,
  onTooltipShow,
  onTooltipHide,
}: GanttMilestoneProps) {
  const dateStr = task.date ?? task.start_date ?? task.end_date;
  if (!dateStr) return null;

  const x = xScale(parseDate(dateStr));
  const cy = y + height / 2;
  const size = 6;
  const color = taskType?.color ?? "#E74C3C";

  const hlStroke = highlightType
    ? isFriendlyRelation(highlightType)
      ? "var(--color-complete)"
      : "var(--color-danger)"
    : color;

  return (
    <g
      role="graphics-symbol"
      aria-label={`Milestone: ${task.title}, ${dateStr}, ${task.state}`}
      tabIndex={0}
      onMouseEnter={(e) => onTooltipShow?.(task, e)}
      onMouseLeave={() => onTooltipHide?.()}
      onFocus={(e) => onTooltipShow?.(task, e)}
      onBlur={() => onTooltipHide?.()}
      style={{ cursor: "default" }}
      className="gantt-focusable"
      opacity={isDimmed ? 0.3 : 1}
    >
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
          fill="var(--color-text-muted)"
          style={{ pointerEvents: "none" }}
        >
          {formatIssueId(task.id)}
        </text>
      )}
    </g>
  );
}
