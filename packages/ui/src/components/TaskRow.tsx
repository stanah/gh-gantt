import React from "react";
import type { Task, StatusValue, TaskType } from "../types/index.js";
import { StatusBadge } from "./StatusBadge.js";
import { PriorityBadge } from "./PriorityBadge.js";
import { ProgressBar } from "./ProgressBar.js";
import { formatIssueId } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";
import type { DropIndicator } from "../hooks/useTreeDragDrop.js";
import { isOverdue, isAtRisk, getOverdueDays, getDaysUntilDue } from "../lib/date-utils.js";

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
  showPriority?: boolean;
  priorityFieldName?: string;
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
      <mark style={{ background: "var(--color-highlight-search)", padding: 0, borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function getBodyPreview(body: string | null, maxLength = 180): string | null {
  if (!body) return null;

  const cleaned = body
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
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
  showPriority,
  priorityFieldName,
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
  const atRiskThresholdDays = 3;
  const overdue = !isMilestone && isOverdue(task);
  const atRisk = !isMilestone && !overdue && isAtRisk(task, atRiskThresholdDays);
  const overdueDays = overdue ? getOverdueDays(task) : 0;
  const daysUntilDue = atRisk ? getDaysUntilDue(task) : null;
  const bodyPreview = isHovered && !isDragging ? getBodyPreview(task.body) : null;
  const showBodyPreview = Boolean(bodyPreview);

  const isBlockRelation = highlightType === "blocker" || highlightType === "blocked";
  const isParentRelation = highlightType === "parent" || highlightType === "child";
  const highlightBg = isBlockRelation
    ? "var(--color-highlight-blocker-bg)"
    : isParentRelation
      ? "var(--color-highlight-parent-bg)"
      : undefined;
  const highlightBorder = isBlockRelation
    ? "3px solid var(--color-highlight-blocker-border)"
    : isParentRelation
      ? "3px solid var(--color-highlight-parent-border)"
      : undefined;

  const dropActive = dropIndicator?.targetTaskId === task.id;
  const dropValid = dropActive && dropIndicator.valid;
  const dropInvalid = dropActive && !dropIndicator.valid;
  const isDependencyDrop = dropActive && dropIndicator.mode === "dependency";
  const dropBorderLeft = dropValid
    ? isDependencyDrop
      ? "2px solid var(--color-drop-dependency-border)"
      : "2px solid var(--color-drop-reparent-border)"
    : dropInvalid
      ? "2px dashed var(--color-danger)"
      : highlightBorder;
  const dropBg = dropValid
    ? isDependencyDrop
      ? "var(--color-drop-dependency-bg)"
      : "var(--color-drop-reparent-bg)"
    : dropInvalid
      ? "var(--color-drop-invalid-bg)"
      : undefined;

  const bg =
    dropBg ??
    (isSelected
      ? "var(--color-selected-bg)"
      : (highlightBg ?? (isHovered ? "var(--color-hover-bg)" : "transparent")));

  return (
    <div
      data-task-id={task.id}
      draggable={isDraggable}
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={() => onHover?.(task.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(task.id)}
      onBlur={() => onHover?.(null)}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        display: "flex",
        position: "relative",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        paddingLeft: dropBorderLeft ? 5 + indent : 8 + indent,
        cursor: isDraggable ? "grab" : "pointer",
        background: bg,
        borderBottom: "1px solid var(--color-border-light)",
        borderLeft: dropBorderLeft,
        height: 28,
        minWidth: 0,
        opacity: isDragging ? 0.3 : isDimmed ? 0.4 : 1,
      }}
    >
      {hasChildren ? (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          style={{
            width: 16,
            textAlign: "center",
            fontSize: 10,
            color: "var(--color-text-muted)",
            flexShrink: 0,
            cursor: "pointer",
          }}
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
        <span
          style={{
            fontSize: 10,
            color: "var(--color-text-muted)",
            flexShrink: 0,
            fontFamily: "monospace",
          }}
        >
          {formatIssueId(task.id)}
        </span>
      )}

      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12,
        }}
      >
        <HighlightedText text={task.title} query={searchQuery?.trim() ?? ""} />
      </span>

      {!isMilestone && showAssignees && task.assignees.length > 0 && (
        <span
          style={{
            fontSize: 10,
            color: "var(--color-text-secondary)",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {task.assignees.length <= 2
            ? task.assignees.map((a) => `@${a}`).join(" ")
            : `@${task.assignees[0]} @${task.assignees[1]} +${task.assignees.length - 2}`}
        </span>
      )}

      {isMilestone && task.date && (
        <span
          style={{
            fontSize: 10,
            color: "var(--color-text-muted)",
            flexShrink: 0,
            fontFamily: "monospace",
          }}
        >
          {task.date.slice(0, 10)}
        </span>
      )}

      {overdue && (
        <span
          title={`期限超過: ${overdueDays}日`}
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#fff",
            background: "var(--color-danger)",
            borderRadius: 10,
            padding: "1px 6px",
            flexShrink: 0,
          }}
        >
          +{overdueDays}d
        </span>
      )}

      {atRisk && daysUntilDue != null && (
        <span
          title={`期限まで: ${daysUntilDue}日`}
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--color-atrisk-fg)",
            background: "var(--color-atrisk-bg)",
            borderRadius: 10,
            padding: "1px 6px",
            flexShrink: 0,
          }}
        >
          D-{daysUntilDue}
        </span>
      )}

      {!isMilestone && showPriority && priorityFieldName && (
        <PriorityBadge priority={task.custom_fields[priorityFieldName] as string | undefined} />
      )}
      {!isMilestone && <StatusBadge status={status} statusValues={statusValues} />}
      {!isMilestone && <ProgressBar progress={progress} color={taskType?.color} />}

      {showBodyPreview && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: Math.max(28 + indent, 40),
            top: 26,
            maxWidth: 420,
            padding: "6px 8px",
            fontSize: 11,
            lineHeight: 1.45,
            color: "var(--color-text)",
            background: "var(--color-surface)",
            border: "1px solid #dfe6ee",
            borderRadius: 6,
            boxShadow: "0 4px 10px rgba(0, 0, 0, 0.12)",
            zIndex: 25,
            pointerEvents: "none",
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {bodyPreview}
        </div>
      )}
    </div>
  );
}
