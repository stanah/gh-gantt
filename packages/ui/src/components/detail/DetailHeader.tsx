import React from "react";
import { ProgressBar } from "../ProgressBar.js";

interface DetailHeaderProps {
  task: {
    id: string;
    title: string;
    github_issue: number | null;
    github_repo: string;
    state: "open" | "closed";
    parent: string | null;
    _progress?: number;
  };
  parentTask: { id: string; title: string; github_issue: number | null } | null;
  onSelectTask: (taskId: string) => void;
  isMilestone?: boolean;
  taskTypeColor?: string;
}

function buildGithubUrl(task: DetailHeaderProps["task"], isMilestone: boolean): string | null {
  if (isMilestone) {
    if (!task.github_repo) return null;
    const suffix = task.id.split("#").pop();
    if (!suffix || !/^\d+$/.test(suffix)) return null;
    return `https://github.com/${task.github_repo}/milestone/${suffix}`;
  }
  if (task.github_issue) {
    return `https://github.com/${task.github_repo}/issues/${task.github_issue}`;
  }
  return null;
}

export function DetailHeader({
  task,
  parentTask,
  onSelectTask,
  isMilestone = false,
  taskTypeColor,
}: DetailHeaderProps) {
  const githubUrl = buildGithubUrl(task, isMilestone);
  const progress = task._progress ?? 0;

  const stateBg = task.state === "open" ? "var(--color-success-bg)" : "var(--color-complete-bg)";
  const stateColor = task.state === "open" ? "var(--color-success)" : "var(--color-complete)";
  const stateLabel = task.state === "open" ? "Open" : "Closed";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Breadcrumb: parent row */}
      {parentTask && (
        <div
          style={{
            fontSize: 12,
            color: "var(--color-text-muted)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            cursor: "pointer",
          }}
          onClick={() => onSelectTask(parentTask.id)}
        >
          <span>{parentTask.title}</span>
          {parentTask.github_issue != null && (
            <span style={{ opacity: 0.7 }}>#{parentTask.github_issue}</span>
          )}
        </div>
      )}

      {/* Current task title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {githubUrl ? (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--color-info)",
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span>{task.title}</span>
            {task.github_issue != null && <span>#{task.github_issue}</span>}
            {/* External link icon */}
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 1h4v4M11 1L5.5 6.5M5 2H2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8" />
            </svg>
          </a>
        ) : (
          <span
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--color-info)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span>{task.title}</span>
            {task.github_issue != null && <span>#{task.github_issue}</span>}
          </span>
        )}
      </div>

      {/* State badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 500,
            background: stateBg,
            color: stateColor,
          }}
        >
          {stateLabel}
        </span>
      </div>

      {/* Progress bar (non-milestone only) */}
      {!isMilestone && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProgressBar progress={progress} color={taskTypeColor} />
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{progress}%</span>
        </div>
      )}
    </div>
  );
}
