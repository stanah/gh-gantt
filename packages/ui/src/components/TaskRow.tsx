import React from "react";
import type { Task, StatusValue, TaskType } from "../types/index.js";
import { StatusBadge } from "./StatusBadge.js";
import { ProgressBar } from "./ProgressBar.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";
import type { DropIndicator } from "../hooks/useTreeDragDrop.js";

interface TaskRowProps {
  task: Task;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
  isSelected: boolean;
  isHovered?: boolean;
  onHover?: (taskId: string | null) => void;
  statusFieldName: string;
  statusValues: Record<string, StatusValue>;
  taskType: TaskType | undefined;
  showIssueId?: boolean;
  showAssignees?: boolean;
  highlightType?: RelationType | null;
  isDimmed?: boolean;
  searchQuery?: string;
  draggable?: boolean;
  isDragging?: boolean;
  dropIndicator?: DropIndicator | null;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "#fef08a", padding: 0, borderRadius: 2 }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function TaskRow({
  task,
  depth,
  hasChildren,
  isCollapsed,
  onToggle,
  onClick,
  isSelected,
  isHovered,
  onHover,
  statusFieldName,
  statusValues,
  taskType,
  showIssueId,
  showAssignees,
  highlightType,
  isDimmed,
  searchQuery,
  draggable: isDraggable,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: TaskRowProps) {
  const indent = depth * 20;
  const progress = task._progress ?? 0;
  const status = task.custom_fields[statusFieldName] as string | undefined;
  const isMilestone = task.type === "milestone";

  const isBlockRelation = highlightType === "blocker" || highlightType === "blocked";
  const isParentRelation = highlightType === "parent" || highlightType === "child";
  const highlightBg = isBlockRelation ? "#fef2f2" : isParentRelation ? "#f5f0ff" : undefined;
  const highlightBorder = isBlockRelation ? "3px solid #e74c3c" : isParentRelation ? "3px solid #8957e5" : undefined;

  const dropValid = dropIndicator?.targetTaskId === task.id && dropIndicator.valid;
  const dropInvalid = dropIndicator?.targetTaskId === task.id && !dropIndicator.valid;
  const dropBorderLeft = dropValid ? "2px solid #4285f4" : dropInvalid ? "2px dashed #e74c3c" : highlightBorder;
  const dropBg = dropValid ? "#e8f0fe" : dropInvalid ? "#fef2f2" : undefined;

  const bg = dropBg ?? (isSelected ? "#e8f0fe" : highlightBg ?? (isHovered ? "#f5f8ff" : "transparent"));

  return (
    <div
      draggable={isDraggable}
      onClick={onClick}
      onMouseEnter={() => onHover?.(task.id)}
      onMouseLeave={() => onHover?.(null)}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        paddingLeft: dropBorderLeft ? 5 + indent : 8 + indent,
        cursor: isDraggable ? "grab" : "pointer",
        background: bg,
        borderBottom: "1px solid #f0f0f0",
        borderLeft: dropBorderLeft,
        height: 28,
        minWidth: 0,
        opacity: isDragging ? 0.3 : isDimmed ? 0.4 : 1,
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
        <HighlightedText text={task.title} query={searchQuery?.trim() ?? ""} />
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
