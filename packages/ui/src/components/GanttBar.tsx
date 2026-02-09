import React from "react";
import type { ScaleTime } from "d3-scale";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";

interface GanttBarProps {
  task: Task;
  taskType: TaskType | undefined;
  xScale: ScaleTime<number, number>;
  y: number;
  height: number;
  onClick: () => void;
  isSelected: boolean;
}

export function GanttBar({ task, taskType, xScale, y, height, onClick, isSelected }: GanttBarProps) {
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

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Background */}
      <rect
        x={x1}
        y={barY}
        width={width}
        height={barHeight}
        rx={3}
        fill={color + "44"}
        stroke={isSelected ? "#333" : color}
        strokeWidth={isSelected ? 2 : 1}
      />
      {/* Progress fill */}
      <rect
        x={x1}
        y={barY}
        width={width * (progress / 100)}
        height={barHeight}
        rx={3}
        fill={color}
        opacity={0.7}
      />
      {/* Label */}
      {width > 60 && (
        <text
          x={x1 + 6}
          y={barY + barHeight / 2 + 4}
          fontSize={10}
          fill="#333"
          style={{ pointerEvents: "none" }}
        >
          {task.title.length > Math.floor(width / 7) ? task.title.slice(0, Math.floor(width / 7)) + "..." : task.title}
        </text>
      )}
    </g>
  );
}
