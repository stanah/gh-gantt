import React from "react";
import type { Task, StatusValue, TaskType } from "../types/index.js";
import { StatusBadge } from "./StatusBadge.js";
import { ProgressBar } from "./ProgressBar.js";

interface TaskRowProps {
  task: Task;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
  onDoubleClick: () => void;
  isSelected: boolean;
  statusFieldName: string;
  statusValues: Record<string, StatusValue>;
  taskType: TaskType | undefined;
}

export function TaskRow({
  task,
  depth,
  hasChildren,
  isCollapsed,
  onToggle,
  onClick,
  onDoubleClick,
  isSelected,
  statusFieldName,
  statusValues,
  taskType,
}: TaskRowProps) {
  const indent = depth * 20;
  const progress = task._progress ?? 0;
  const status = task.custom_fields[statusFieldName] as string | undefined;

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        paddingLeft: 8 + indent,
        cursor: "pointer",
        background: isSelected ? "#e8f0fe" : "transparent",
        borderBottom: "1px solid #f0f0f0",
        height: 28,
        minWidth: 0,
      }}
    >
      {hasChildren ? (
        <span
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          style={{ width: 16, textAlign: "center", fontSize: 10, color: "#888", flexShrink: 0, cursor: "pointer" }}
        >
          {isCollapsed ? "\u25B6" : "\u25BC"}
        </span>
      ) : (
        <span style={{ width: 16, flexShrink: 0 }} />
      )}

      {taskType && (
        <span
          style={{
            width: 4,
            height: 14,
            borderRadius: 2,
            background: taskType.color,
            flexShrink: 0,
          }}
        />
      )}

      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
        {task.title}
      </span>

      <StatusBadge status={status} statusValues={statusValues} />
      <ProgressBar progress={progress} color={taskType?.color} />
    </div>
  );
}
