import React, { useState, useCallback, useEffect, useRef } from "react";
import type { Task, Config } from "../types/index.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { DetailHeader } from "./detail/DetailHeader.js";
import { DetailMetaSidebar } from "./detail/DetailMetaSidebar.js";
import { DetailSubTasks } from "./detail/DetailSubTasks.js";
import { DetailRelations } from "./detail/DetailRelations.js";

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 800;
const TWO_COLUMN_THRESHOLD = 560;

interface TaskDetailPanelProps {
  task: Task;
  config: Config;
  comments: Array<{ author: string; body: string; created_at: string }>;
  allTasks: Task[];
  onUpdate: (updates: Partial<Task>) => void;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  renderMarkdownPreview?: (value: string) => React.ReactNode;
  width?: number;
  onWidthChange?: (width: number) => void;
}

export function TaskDetailPanel({
  task,
  config,
  comments,
  allTasks,
  onUpdate,
  onClose,
  onSelectTask,
  renderMarkdownPreview,
  width = 400,
  onWidthChange,
}: TaskDetailPanelProps) {
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(null);
  const dragging = useRef(false);

  const statusFieldName = config.statuses.field_name;
  const currentStatus = task.custom_fields[statusFieldName] as string | undefined;
  const taskType = config.task_types[task.type];
  const isMilestone = task.type === "milestone";
  const isTwoColumn = width >= TWO_COLUMN_THRESHOLD;
  const renderPreview =
    renderMarkdownPreview ?? ((value: string) => <MarkdownRenderer markdown={value} />);

  const parentTask = task.parent
    ? (() => {
        const p = allTasks.find((t) => t.id === task.parent);
        return p ? { id: p.id, title: p.title, github_issue: p.github_issue } : null;
      })()
    : null;

  const copyTaskInfo = useCallback(() => {
    const ref = task.github_issue ? `${task.github_repo}#${task.github_issue}` : task.id;
    const info: Record<string, unknown> = {
      ref,
      title: task.title,
      type: task.type,
      state: task.state,
      status: currentStatus ?? null,
    };
    if (task.body) info.description = task.body;
    if (task.assignees.length > 0) info.assignees = task.assignees;
    if (task.labels.length > 0) info.labels = task.labels;
    if (task.milestone) info.milestone = task.milestone;
    if (isMilestone) {
      if (task.date) info.due_date = task.date;
    } else {
      if (task.start_date) info.start_date = task.start_date;
      if (task.end_date) info.end_date = task.end_date;
    }
    if (task.parent) info.parent = task.parent;
    if (task.sub_tasks.length > 0) info.sub_tasks = task.sub_tasks;
    if (task.blocked_by.length > 0) info.blocked_by = task.blocked_by.map((d) => d.task);
    if (task.linked_prs.length > 0) info.linked_prs = task.linked_prs;

    navigator.clipboard
      .writeText(JSON.stringify(info, null, 2))
      .then(() => {
        setCopyFeedback("success");
        setTimeout(() => setCopyFeedback(null), 1500);
      })
      .catch(() => {
        setCopyFeedback("error");
        setTimeout(() => setCopyFeedback(null), 1500);
      });
  }, [task, currentStatus, isMilestone]);

  const resizeListeners = useRef<{
    onMouseMove: (ev: MouseEvent) => void;
    onMouseUp: () => void;
  } | null>(null);

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onWidthChange) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      dragging.current = true;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth + delta));
        onWidthChange(newWidth);
      };

      const onMouseUp = () => {
        dragging.current = false;
        resizeListeners.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      resizeListeners.current = { onMouseMove, onMouseUp };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [width, onWidthChange],
  );

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (dragging.current && resizeListeners.current) {
        document.removeEventListener("mousemove", resizeListeners.current.onMouseMove);
        document.removeEventListener("mouseup", resizeListeners.current.onMouseUp);
      }
    };
  }, []);

  // Priority for inline badges (1-column)
  const priorityFieldName = config.sync?.field_mapping?.priority;
  const rawPriority = priorityFieldName ? task.custom_fields[priorityFieldName] : undefined;
  const currentPriority = typeof rawPriority === "string" ? rawPriority : "";

  const dateRange = isMilestone
    ? task.date
      ? task.date.slice(0, 10)
      : null
    : task.start_date && task.end_date
      ? `${task.start_date.slice(0, 10)} \u2013 ${task.end_date.slice(0, 10)}`
      : task.start_date
        ? task.start_date.slice(0, 10)
        : task.end_date
          ? task.end_date.slice(0, 10)
          : null;

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        height: "100%",
        background: "var(--color-surface)",
        borderLeft: "1px solid var(--color-border)",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Resize handle */}
      {onWidthChange && (
        <div
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          onMouseDown={onResizeMouseDown}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 5,
            height: "100%",
            cursor: "col-resize",
            zIndex: 10,
          }}
        />
      )}

      {/* Panel header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          {task.github_repo || task.id}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={copyTaskInfo}
            title="Copy task info as JSON"
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              color:
                copyFeedback === "success"
                  ? "var(--color-success)"
                  : copyFeedback === "error"
                    ? "var(--color-danger)"
                    : "var(--color-text-muted)",
              padding: 4,
              display: "flex",
              alignItems: "center",
              transition: "color 0.2s",
            }}
          >
            {copyFeedback === "success" ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 8.5 6.5 11 12 5" />
              </svg>
            ) : copyFeedback === "error" ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="5.5" y="5.5" width="8" height="9" rx="1" />
                <path d="M10.5 5.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h2.5" />
              </svg>
            )}
          </button>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: 18,
              cursor: "pointer",
              color: "var(--color-text-muted)",
            }}
          >
            x
          </button>
        </div>
      </div>

      {/* Content area */}
      {isTwoColumn ? (
        /* Two-column layout */
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Left column */}
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <DetailHeader
              task={task}
              parentTask={parentTask}
              onSelectTask={onSelectTask}
              onTitleEdit={(title) => onUpdate({ title })}
              isMilestone={isMilestone}
              taskTypeColor={taskType?.color}
            />

            {/* Description */}
            <div>
              <label
                style={{
                  fontSize: 11,
                  color: "var(--color-text-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Description
              </label>
              <MarkdownEditor
                value={task.body ?? ""}
                onChange={(body) => onUpdate({ body })}
                renderPreview={renderPreview}
              />
            </div>

            {/* Sub-tasks */}
            {task.sub_tasks.length > 0 && (
              <DetailSubTasks
                subTaskIds={task.sub_tasks}
                allTasks={allTasks}
                onSelectTask={onSelectTask}
              />
            )}

            {/* Relations */}
            <DetailRelations
              blockedBy={task.blocked_by}
              linkedPrs={task.linked_prs}
              allTasks={allTasks}
              onSelectTask={onSelectTask}
              githubRepo={task.github_repo}
            />

            {/* Comments */}
            {comments.length > 0 && (
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-muted)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Comments ({comments.length})
                </label>
                {comments.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 8,
                      background: "var(--color-bg)",
                      borderRadius: 4,
                      marginBottom: 4,
                    }}
                  >
                    <div
                      style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}
                    >
                      <strong>{c.author}</strong> - {new Date(c.created_at).toLocaleString()}
                    </div>
                    <MarkdownRenderer markdown={c.body} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right column - Meta sidebar */}
          <div
            style={{
              width: 200,
              flexShrink: 0,
              borderLeft: "1px solid var(--color-border)",
              overflow: "auto",
              padding: 12,
            }}
          >
            <DetailMetaSidebar
              task={task}
              config={config}
              onUpdate={onUpdate}
              isMilestone={isMilestone}
            />
          </div>
        </div>
      ) : (
        /* Single-column layout */
        <div
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            flex: 1,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          <DetailHeader
            task={task}
            parentTask={parentTask}
            onSelectTask={onSelectTask}
            onTitleEdit={(title) => onUpdate({ title })}
            isMilestone={isMilestone}
            taskTypeColor={taskType?.color}
          />

          {/* Inline badges */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
            <span
              style={{
                padding: "2px 8px",
                fontSize: 10,
                background:
                  task.state === "open"
                    ? "var(--color-success-bg)"
                    : "var(--color-complete-bg, var(--color-border-light))",
                color:
                  task.state === "open"
                    ? "var(--color-success)"
                    : "var(--color-complete, var(--color-text-muted))",
                borderRadius: 12,
              }}
            >
              ● {task.state === "open" ? "Open" : "Closed"}
            </span>
            {currentStatus && (
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "var(--color-border-light)",
                  borderRadius: 12,
                }}
              >
                {currentStatus}
              </span>
            )}
            {currentPriority && (
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "var(--color-border-light)",
                  borderRadius: 12,
                }}
              >
                {currentPriority}
              </span>
            )}
            {!isMilestone && taskType && (
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "var(--color-border-light)",
                  borderRadius: 12,
                }}
              >
                {taskType.label}
              </span>
            )}
            {dateRange && (
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "var(--color-border-light)",
                  borderRadius: 12,
                }}
              >
                {dateRange}
              </span>
            )}
            {task.assignees.map((a) => (
              <span
                key={a}
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "var(--color-selected-bg)",
                  borderRadius: 12,
                }}
              >
                {a}
              </span>
            ))}
          </div>

          {/* Description */}
          <div>
            <label
              style={{
                fontSize: 11,
                color: "var(--color-text-muted)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Description
            </label>
            <MarkdownEditor
              value={task.body ?? ""}
              onChange={(body) => onUpdate({ body })}
              renderPreview={renderPreview}
            />
          </div>

          {/* Sub-tasks */}
          {task.sub_tasks.length > 0 && (
            <DetailSubTasks
              subTaskIds={task.sub_tasks}
              allTasks={allTasks}
              onSelectTask={onSelectTask}
            />
          )}

          {/* Relations */}
          <DetailRelations
            blockedBy={task.blocked_by}
            linkedPrs={task.linked_prs}
            allTasks={allTasks}
            onSelectTask={onSelectTask}
            githubRepo={task.github_repo}
          />

          {/* Comments */}
          {comments.length > 0 && (
            <div>
              <label
                style={{
                  fontSize: 11,
                  color: "var(--color-text-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Comments ({comments.length})
              </label>
              {comments.map((c, i) => (
                <div
                  key={i}
                  style={{
                    padding: 8,
                    background: "var(--color-bg)",
                    borderRadius: 4,
                    marginBottom: 4,
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>
                    <strong>{c.author}</strong> - {new Date(c.created_at).toLocaleString()}
                  </div>
                  <MarkdownRenderer markdown={c.body} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
