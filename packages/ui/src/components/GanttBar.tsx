import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import type { DragMode } from "../hooks/useDragResize.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

interface GanttBarProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  onClick: () => void;
  isSelected: boolean;
  onDragStart?: (e: React.MouseEvent, mode: DragMode) => void;
  showIssueId?: boolean;
  showAssignees?: boolean;
  isDimmed?: boolean;
  highlightType?: RelationType | null;
}

function highlightStroke(type: RelationType | null | undefined): { stroke: string; strokeWidth: number } | null {
  if (!type) return null;
  if (type === "parent" || type === "child") return { stroke: "#8957e5", strokeWidth: 2 };
  return { stroke: "#e74c3c", strokeWidth: 2 };
}

export function GanttBar({ task, taskType, xScale, y, height, onClick, isSelected, onDragStart, showIssueId, showAssignees, isDimmed, highlightType }: GanttBarProps) {
  if (!task.start_date || !task.end_date) return null;

  const x1 = xScale(parseDate(task.start_date));
  const endDate = parseDate(task.end_date);
  endDate.setDate(endDate.getDate() + 1);
  const x2 = xScale(endDate);
  const width = Math.max(x2 - x1, 4);
  const color = taskType?.color ?? "#27AE60";
  const progress = task._progress ?? 0;
  const barHeight = height - 8;
  const barY = y + 4;
  const handleWidth = 6;

  const hl = highlightStroke(highlightType);

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }} opacity={isDimmed ? 0.3 : 1}>
      {/* Background */}
      <rect
        x={x1}
        y={barY}
        width={width}
        height={barHeight}
        rx={3}
        fill={color + "44"}
        stroke={isSelected ? "#333" : hl ? hl.stroke : color}
        strokeWidth={isSelected ? 2 : hl ? hl.strokeWidth : 1}
      />
      {/* Progress fill */}
      <rect
        x={x1}
        y={barY}
        width={width * (progress / 100)}
        height={barHeight}
        rx={3}
        fill={progress === 100 ? "#999" : color}
        opacity={0.7}
      />
      {/* Label + Assignee */}
      {(() => {
        const issueLabel = showIssueId ? formatIssueId(task.id) : "";
        const prefix = issueLabel ? issueLabel + " " : "";
        const fullText = prefix + task.title;
        const charWidth = 7;
        const padding = 12;
        const fitsInside = fullText.length * charWidth + padding < width;

        const assigneeText = showAssignees && task.assignees.length > 0
          ? (task.assignees.length <= 2
              ? task.assignees.map((a) => `@${a}`).join(" ")
              : `@${task.assignees[0]} +${task.assignees.length - 1}`)
          : "";

        if (fitsInside) {
          const maxChars = Math.floor((width - padding) / charWidth);
          const label = fullText.length > maxChars
            ? fullText.slice(0, maxChars) + "..."
            : fullText;
          return (
            <text x={x1 + 6} y={barY + barHeight / 2 + 4}
                  fontSize={10} fill="#333"
                  style={{ pointerEvents: "none" }}>
              {label}
              {assigneeText && (
                <tspan fontSize={9} fill="#888">{" "}{assigneeText}</tspan>
              )}
            </text>
          );
        }

        const maxOutsideChars = 30;
        const outsideLabel = fullText.length > maxOutsideChars
          ? fullText.slice(0, maxOutsideChars) + "..."
          : fullText;
        return (
          <text x={x1 + width + 4} y={barY + barHeight / 2 + 4}
                fontSize={10} fill="#666"
                style={{ pointerEvents: "none" }}>
            {outsideLabel}
            {assigneeText && (
              <tspan fontSize={9} fill="#888">{" "}{assigneeText}</tspan>
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
