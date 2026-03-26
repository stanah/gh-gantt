import React from "react";
import type { Task, TaskType } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";

interface GanttTooltipProps {
  task: Task;
  taskType: TaskType | undefined;
  x: number;
  y: number;
  /** Summary date range from parent calculation (for summary bars) */
  summaryDates?: { start: string; end: string } | null;
}

function calcDurationDays(startStr: string, endStr: string): number {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

function formatDateLabel(dateStr: string): string {
  const d = parseDate(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export function GanttTooltip({ task, taskType, x, y, summaryDates }: GanttTooltipProps) {
  const display = taskType?.display ?? "bar";
  const progress = task._progress ?? 0;

  // Determine dates based on display type
  const startDate = summaryDates?.start ?? task.start_date;
  const endDate = summaryDates?.end ?? task.end_date;
  const milestoneDate = task.date ?? task.start_date ?? task.end_date;

  const duration =
    display === "milestone"
      ? null
      : startDate && endDate
        ? calcDurationDays(startDate, endDate)
        : null;

  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        left: x,
        top: y - 8,
        transform: "translate(-50%, -100%)",
        padding: "8px 10px",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--color-text)",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        zIndex: 50,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        maxWidth: 360,
      }}
    >
      {/* Title row */}
      <div
        style={{
          fontWeight: 600,
          fontSize: 12,
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 340,
        }}
      >
        {taskType && (
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: 2,
              backgroundColor: taskType.color,
              marginRight: 5,
              verticalAlign: "middle",
            }}
          />
        )}
        {task.title}
      </div>

      {/* Date info */}
      <div style={{ color: "var(--color-text-secondary)" }}>
        {display === "milestone" && milestoneDate && <div>{formatDateLabel(milestoneDate)}</div>}
        {display !== "milestone" && startDate && endDate && (
          <div>
            {formatDateLabel(startDate)} ~ {formatDateLabel(endDate)}
            {duration != null && (
              <span style={{ marginLeft: 6, color: "var(--color-text-muted)" }}>({duration}d)</span>
            )}
          </div>
        )}
      </div>

      {/* Progress */}
      {display !== "milestone" && (
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: "var(--color-border)",
              minWidth: 60,
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                borderRadius: 2,
                background:
                  progress === 100
                    ? "var(--color-complete)"
                    : progress > 0
                      ? "var(--color-in-progress)"
                      : "transparent",
              }}
            />
          </div>
          <span style={{ fontSize: 10, color: "var(--color-text-muted)", minWidth: 28 }}>
            {progress}%
          </span>
        </div>
      )}

      {/* State for milestones */}
      {display === "milestone" && (
        <div style={{ marginTop: 2, fontSize: 10, color: "var(--color-text-muted)" }}>
          {task.state === "closed" ? "Closed" : "Open"}
        </div>
      )}

      {/* Assignees */}
      {task.assignees.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--color-text-muted)" }}>
          {task.assignees.map((a) => `@${a}`).join(", ")}
        </div>
      )}
    </div>
  );
}
