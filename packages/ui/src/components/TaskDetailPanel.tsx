import React, { useState, useCallback } from "react";
import type { Task, Config } from "../types/index.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { StatusBadge } from "./StatusBadge.js";
import { ProgressBar } from "./ProgressBar.js";

interface TaskDetailPanelProps {
  task: Task;
  config: Config;
  comments: Array<{ author: string; body: string; created_at: string }>;
  onUpdate: (updates: Partial<Task>) => void;
  onClose: () => void;
}

export function TaskDetailPanel({ task, config, comments, onUpdate, onClose }: TaskDetailPanelProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const statusFieldName = config.statuses.field_name;
  const currentStatus = task.custom_fields[statusFieldName] as string | undefined;
  const statusOptions = Object.keys(config.statuses.values);
  const taskType = config.task_types[task.type];
  const isMilestone = task.type === "milestone";

  const copyTaskInfo = useCallback(() => {
    const ref = task.github_issue
      ? `${task.github_repo}#${task.github_issue}`
      : task.id;
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

    navigator.clipboard.writeText(JSON.stringify(info, null, 2)).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    }).catch(() => {
      console.warn("Failed to copy to clipboard");
    });
  }, [task, currentStatus, isMilestone]);

  const githubUrl = isMilestone
    ? (() => {
        if (!task.github_repo) return null;
        const suffix = task.id.split("#").pop();
        if (!suffix || !/^\d+$/.test(suffix)) return null;
        return `https://github.com/${task.github_repo}/milestone/${suffix}`;
      })()
    : task.github_issue
      ? `https://github.com/${task.github_repo}/issues/${task.github_issue}`
      : null;

  return (
    <div style={{ width: 400, flexShrink: 0, height: "100%", background: "#fff", borderLeft: "1px solid #e0e0e0", overflow: "auto" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e0e0e0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "#888" }}>{task.id}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={copyTaskInfo}
            title="Copy task info as JSON"
            style={{
              border: "none", background: "none",
              cursor: "pointer", color: copyFeedback ? "#27AE60" : "#888",
              padding: 4, display: "flex", alignItems: "center", transition: "color 0.2s",
            }}
          >
            {copyFeedback ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 8.5 6.5 11 12 5" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5.5" y="5.5" width="8" height="9" rx="1" />
                <path d="M10.5 5.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h2.5" />
              </svg>
            )}
          </button>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 18, cursor: "pointer", color: "#888" }}>x</button>
        </div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Title */}
        {editingTitle ? (
          <div>
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => { onUpdate({ title: titleDraft }); setEditingTitle(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { onUpdate({ title: titleDraft }); setEditingTitle(false); } }}
              autoFocus
              style={{ width: "100%", padding: 4, fontSize: 16, fontWeight: 600, border: "1px solid #3498DB", borderRadius: 4 }}
            />
          </div>
        ) : (
          <h2
            onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
            style={{ fontSize: 16, cursor: "pointer", margin: 0 }}
          >
            {task.title}
          </h2>
        )}

        {/* Progress (tasks only) */}
        {!isMilestone && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ProgressBar progress={task._progress ?? 0} color={taskType?.color} />
            <span style={{ fontSize: 11, color: "#888" }}>{task._progress ?? 0}%</span>
          </div>
        )}

        {/* Status (tasks only) */}
        {!isMilestone && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Status</label>
            <select
              value={currentStatus ?? ""}
              onChange={(e) => onUpdate({ custom_fields: { ...task.custom_fields, [statusFieldName]: e.target.value } })}
              style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #ccc", borderRadius: 4 }}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        {/* State */}
        <div>
          <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>State</label>
          <button
            onClick={() => onUpdate({ state: task.state === "open" ? "closed" : "open" })}
            style={{
              padding: "4px 12px", fontSize: 12, borderRadius: 4, cursor: "pointer",
              border: `1px solid ${task.state === "open" ? "#27AE60" : "#888"}`,
              background: task.state === "open" ? "#27AE6022" : "#88888822",
              color: task.state === "open" ? "#27AE60" : "#888",
            }}
          >
            {task.state === "open" ? "Open" : "Closed"}
          </button>
        </div>

        {/* Dates */}
        {isMilestone ? (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Due Date</label>
            <input
              type="date"
              value={(task.date ?? "").slice(0, 10)}
              onChange={(e) => onUpdate({ date: e.target.value || null })}
              style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #ccc", borderRadius: 4, width: "100%" }}
            />
          </div>
        ) : (
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Start Date</label>
              <input
                type="date"
                value={task.start_date ?? ""}
                onChange={(e) => onUpdate({ start_date: e.target.value || null })}
                style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #ccc", borderRadius: 4, width: "100%" }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>End Date</label>
              <input
                type="date"
                value={task.end_date ?? ""}
                onChange={(e) => onUpdate({ end_date: e.target.value || null })}
                style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #ccc", borderRadius: 4, width: "100%" }}
              />
            </div>
          </div>
        )}

        {/* Type (tasks only) */}
        {!isMilestone && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Type</label>
            <select
              value={task.type}
              onChange={(e) => onUpdate({ type: e.target.value })}
              style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #ccc", borderRadius: 4 }}
            >
              {Object.entries(config.task_types).map(([name, def]) => (
                <option key={name} value={name}>{def.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Assignees (tasks only) */}
        {!isMilestone && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Assignees</label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {task.assignees.map((a) => (
                <span key={a} style={{ padding: "2px 8px", fontSize: 11, background: "#e8f0fe", borderRadius: 12 }}>{a}</span>
              ))}
              {task.assignees.length === 0 && <span style={{ color: "#999", fontSize: 11 }}>None</span>}
            </div>
          </div>
        )}

        {/* Labels (tasks only) */}
        {!isMilestone && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Labels</label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {task.labels.map((l) => (
                <span key={l} style={{ padding: "2px 8px", fontSize: 11, background: "#f0f0f0", borderRadius: 3 }}>{l}</span>
              ))}
              {task.labels.length === 0 && <span style={{ color: "#999", fontSize: 11 }}>None</span>}
            </div>
          </div>
        )}

        {/* Body */}
        <div>
          <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Description</label>
          <MarkdownEditor value={task.body ?? ""} onChange={(body) => onUpdate({ body })} />
        </div>

        {/* Sub-tasks */}
        {task.sub_tasks.length > 0 && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Sub-tasks ({task.sub_tasks.length})</label>
            {task.sub_tasks.map((id) => (
              <div key={id} style={{ fontSize: 12, padding: "2px 0" }}>{id}</div>
            ))}
          </div>
        )}

        {/* Blocked by */}
        {task.blocked_by.length > 0 && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Blocked by</label>
            {task.blocked_by.map((dep, i) => (
              <div key={i} style={{ fontSize: 12, padding: "2px 0" }}>{dep.task} ({dep.type})</div>
            ))}
          </div>
        )}

        {/* Linked PRs */}
        {task.linked_prs.length > 0 && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Linked PRs</label>
            {task.linked_prs.map((pr) => (
              <div key={pr} style={{ fontSize: 12, padding: "2px 0" }}>#{pr}</div>
            ))}
          </div>
        )}

        {/* Comments */}
        {comments.length > 0 && (
          <div>
            <label style={{ fontSize: 11, color: "#888", display: "block", marginBottom: 4 }}>Comments ({comments.length})</label>
            {comments.map((c, i) => (
              <div key={i} style={{ padding: 8, background: "#fafafa", borderRadius: 4, marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
                  <strong>{c.author}</strong> - {new Date(c.created_at).toLocaleString()}
                </div>
                <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{c.body}</div>
              </div>
            ))}
          </div>
        )}

        {/* GitHub link */}
        {githubUrl && (
          <div>
            <a href={githubUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#3498DB" }}>
              View on GitHub
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
