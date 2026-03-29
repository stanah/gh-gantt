import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import {
  parseDate,
  isOverdue,
  isAtRisk,
  getOverdueDays,
  getDaysUntilDue,
} from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import { getPriorityColor } from "./PriorityBadge.js";
import type { DragMode } from "../hooks/useDragResize.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

interface GanttBarProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  onClick: (e: React.MouseEvent) => void;
  isSelected: boolean;
  onDragStart?: (e: React.MouseEvent, mode: DragMode) => void;
  showIssueId?: boolean;
  showAssignees?: boolean;
  priorityFieldName?: string;
  isDimmed?: boolean;
  highlightType?: RelationType | null;
  onTooltipShow?: (task: Task, e: React.MouseEvent | React.FocusEvent) => void;
  onTooltipHide?: () => void;
}

function highlightStroke(
  type: RelationType | null | undefined,
): { stroke: string; strokeWidth: number } | null {
  if (!type) return null;
  if (type === "parent" || type === "child")
    return { stroke: "var(--color-complete)", strokeWidth: 2 };
  return { stroke: "var(--color-danger)", strokeWidth: 2 };
}

export function GanttBar({
  task,
  taskType,
  xScale,
  y,
  height,
  onClick,
  isSelected,
  onDragStart,
  showIssueId,
  showAssignees,
  priorityFieldName,
  isDimmed,
  highlightType,
  onTooltipShow,
  onTooltipHide,
}: GanttBarProps) {
  if (!task.start_date || !task.end_date) return null;

  const x1 = xScale(parseDate(task.start_date));
  const endDate = parseDate(task.end_date);
  endDate.setDate(endDate.getDate() + 1);
  const x2 = xScale(endDate);
  const width = Math.max(x2 - x1, 4);
  const color = taskType?.color ?? "#27AE60";
  const barHeight = height - 8;
  const barY = y + 4;
  const handleWidth = 6;
  const atRiskThresholdDays = 3;
  const overdue = isOverdue(task);
  const atRisk = !overdue && isAtRisk(task, atRiskThresholdDays);
  const overdueDays = overdue ? getOverdueDays(task) : 0;
  const daysUntilDue = atRisk ? getDaysUntilDue(task) : null;
  const dangerColor = "var(--color-danger)";
  const warningColor = "var(--color-warning)";
  const scheduleStroke = overdue ? dangerColor : atRisk ? warningColor : color;
  const backgroundFill = overdue
    ? "var(--color-danger-bg)"
    : atRisk
      ? "var(--color-warning-bg)"
      : color;
  const backgroundOpacity = overdue || atRisk ? 1 : 0.27;

  const priority = priorityFieldName
    ? (task.custom_fields[priorityFieldName] as string | undefined)
    : undefined;
  const priorityColor = getPriorityColor(priority);

  const hl = highlightStroke(highlightType);
  const isDone = task.state === "closed";

  return (
    <g
      role="graphics-symbol"
      aria-label={`${task.title}, from ${task.start_date} to ${task.end_date}${overdue ? `, overdue ${overdueDays} days` : atRisk && daysUntilDue != null ? `, due in ${daysUntilDue} days` : ""}${isDone ? ", done" : ""}`}
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={(e) => onTooltipShow?.(task, e)}
      onMouseLeave={() => onTooltipHide?.()}
      onFocus={(e) => onTooltipShow?.(task, e)}
      onBlur={() => onTooltipHide?.()}
      style={{ cursor: "pointer" }}
      className="gantt-focusable"
      opacity={isDimmed ? 0.3 : isDone ? 0.5 : 1}
    >
      {/* Background */}
      <rect
        x={x1}
        y={barY}
        width={width}
        height={barHeight}
        rx={3}
        fill={backgroundFill}
        fillOpacity={backgroundOpacity}
        stroke={isSelected ? "var(--color-text)" : hl ? hl.stroke : scheduleStroke}
        strokeWidth={isSelected ? 2 : hl ? hl.strokeWidth : 1}
        strokeDasharray={!isSelected && !hl && overdue ? "4 2" : undefined}
      />
      {/* Priority indicator (left stripe) */}
      {priorityColor && (
        <rect
          x={x1}
          y={barY}
          width={3}
          height={barHeight}
          rx={1}
          fill={priorityColor}
          opacity={0.9}
        />
      )}
      {/* Label + Assignee */}
      {(() => {
        const issueLabel = showIssueId ? formatIssueId(task.id) : "";
        const prefix = issueLabel ? issueLabel + " " : "";
        const riskPrefix = overdue
          ? `+${overdueDays}d `
          : atRisk && daysUntilDue != null
            ? `D-${daysUntilDue} `
            : "";
        const fullText = riskPrefix + prefix + task.title;
        const charWidth = 7;
        const padding = 12;
        const fitsInside = fullText.length * charWidth + padding < width;

        const assigneeText =
          showAssignees && task.assignees.length > 0
            ? task.assignees.length <= 2
              ? task.assignees.map((a) => `@${a}`).join(" ")
              : `@${task.assignees[0]} +${task.assignees.length - 1}`
            : "";

        if (fitsInside) {
          const maxChars = Math.floor((width - padding) / charWidth);
          const label = fullText.length > maxChars ? fullText.slice(0, maxChars) + "..." : fullText;
          return (
            <text
              x={x1 + 6}
              y={barY + barHeight / 2 + 4}
              fontSize={10}
              fill="var(--color-text-secondary)"
              style={{ pointerEvents: "none" }}
            >
              {label}
              {assigneeText && (
                <tspan fontSize={9} fill="var(--color-text-muted)">
                  {" "}
                  {assigneeText}
                </tspan>
              )}
            </text>
          );
        }

        const maxOutsideChars = 30;
        const outsideLabel =
          fullText.length > maxOutsideChars ? fullText.slice(0, maxOutsideChars) + "..." : fullText;
        return (
          <text
            x={x1 + width + 4}
            y={barY + barHeight / 2 + 4}
            fontSize={10}
            fill="var(--color-text-secondary)"
            style={{ pointerEvents: "none" }}
          >
            {outsideLabel}
            {assigneeText && (
              <tspan fontSize={9} fill="var(--color-text-muted)">
                {" "}
                {assigneeText}
              </tspan>
            )}
          </text>
        );
      })()}

      {/* Drag area (move) */}
      {onDragStart && (
        <rect
          x={x1 + handleWidth}
          y={barY}
          width={Math.max(width - handleWidth * 2, 0)}
          height={barHeight}
          fill="transparent"
          style={{ cursor: "grab" }}
          onMouseDown={(e) => onDragStart(e, "move")}
        />
      )}

      {/* Left resize handle */}
      {onDragStart && (
        <rect
          x={x1}
          y={barY}
          width={handleWidth}
          height={barHeight}
          fill="transparent"
          style={{ cursor: "ew-resize" }}
          onMouseDown={(e) => onDragStart(e, "resize-left")}
        />
      )}

      {/* Right resize handle */}
      {onDragStart && (
        <rect
          x={x1 + width - handleWidth}
          y={barY}
          width={handleWidth}
          height={barHeight}
          fill="transparent"
          style={{ cursor: "ew-resize" }}
          onMouseDown={(e) => onDragStart(e, "resize-right")}
        />
      )}
    </g>
  );
}
