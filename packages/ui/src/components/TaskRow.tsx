import React from "react";
import type { Task, StatusValue, TaskType } from "../types/index.js";
import { StatusBadge } from "./StatusBadge.js";
import { ProgressBar } from "./ProgressBar.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";

interface TaskRowProps {
  task: Task;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
  onDoubleClick: () => void;
  isSelected: boolean;
  isHovered?: boolean;
  onHover?: (taskId: string | null) => void;
  statusFieldName: string;
  statusValues: Record<string, StatusValue>;
  taskType: TaskType | undefined;
  showIssueId?: boolean;
  showAssignees?: boolean;
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
  isHovered,
  onHover,
  statusFieldName,
  statusValues,
  taskType,
  showIssueId,
  showAssignees,
}: TaskRowProps) {
  const indent = depth * 20;
  const progress = task._progress ?? 0;
  const status = task.custom_fields[statusFieldName] as string | undefined;
  const bg = isSelected ? "#e8f0fe" : isHovered ? "#f5f8ff" : "transparent";
  const isMilestone = task.type === "milestone";

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => onHover?.(task.id)}
      onMouseLeave={() => onHover?.(null)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        paddingLeft: 8 + indent,
        cursor: "pointer",
        background: bg,
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

      {showIssueId && (
        <span style={{ fontSize: 10, color: "#888", flexShrink: 0, fontFamily: "monospace" }}>
          {formatIssueId(task.id)}
        </span>
      )}

      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
        {task.title}
      </span>

      {!isMilestone && showAssignees && task.assignees.length > 0 && (
        <span style={{ fontSize: 10, color: "#666", flexShrink: 0, whiteSpace: "nowrap" }}>
          {task.assignees.length <= 2
            ? task.assignees.map((a) => `@${a}`).join(" ")
            : `@${task.assignees[0]} @${task.assignees[1]} +${task.assignees.length - 2}`}
        </span>
      )}

      {isMilestone && task.date && (
        <span style={{ fontSize: 10, color: "#888", flexShrink: 0, fontFamily: "monospace" }}>
          {task.date.slice(0, 10)}
        </span>
      )}

      {!isMilestone && <StatusBadge status={status} statusValues={statusValues} />}
      {!isMilestone && <ProgressBar progress={progress} color={taskType?.color} />}
    </div>
  );
}
