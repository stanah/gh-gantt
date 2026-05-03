import React from "react";
import type { Dependency, LinkedPullRequestRef, Task } from "../../types/index.js";

interface DetailRelationsProps {
  blockedBy: Dependency[];
  linkedPrs: LinkedPullRequestRef[];
  allTasks: Task[];
  onSelectTask: (taskId: string) => void;
  githubRepo: string;
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-muted)",
  fontWeight: 600,
  display: "block",
  marginBottom: 4,
};

function normalizeLinkedPr(pr: LinkedPullRequestRef): {
  number: number;
  title: string | null;
  state: string | null;
  url: string | null;
} {
  if (typeof pr === "number") {
    return { number: pr, title: null, state: null, url: null };
  }
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state.toLowerCase(),
    url: pr.url,
  };
}

function formatPrState(state: string): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    default:
      return state;
  }
}

function prStateStyle(state: string): React.CSSProperties {
  const normalized = state.toLowerCase();
  const color =
    normalized === "merged"
      ? "var(--color-complete)"
      : normalized === "open"
        ? "var(--color-success)"
        : "var(--color-text-muted)";

  return {
    flexShrink: 0,
    padding: "1px 6px",
    borderRadius: 3,
    fontSize: 10,
    lineHeight: "14px",
    color,
    background: "var(--color-border-light)",
  };
}

export function DetailRelations({
  blockedBy,
  linkedPrs,
  allTasks,
  onSelectTask,
  githubRepo,
}: DetailRelationsProps) {
  if (blockedBy.length === 0 && linkedPrs.length === 0) {
    return null;
  }

  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {blockedBy.length > 0 && (
        <div>
          <span style={sectionHeaderStyle}>Blocked by</span>
          {blockedBy.map((dep) => {
            const resolved = taskMap.get(dep.task);
            const title = resolved ? resolved.title : dep.task;
            const issueNumber = dep.task.match(/#(\d+)$/)?.[1];
            return (
              <div
                key={dep.task}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  padding: "2px 0",
                  minWidth: 0,
                }}
              >
                <span style={{ color: "var(--color-danger)", flexShrink: 0 }}>&#8856;</span>
                <button
                  onClick={() => onSelectTask(dep.task)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--color-info)",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  {issueNumber ? `#${issueNumber}` : dep.task}
                </button>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--color-text)",
                  }}
                >
                  {title}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {linkedPrs.length > 0 && (
        <div>
          <span style={sectionHeaderStyle}>Linked PRs</span>
          {linkedPrs.map((pr) => {
            const linkedPr = normalizeLinkedPr(pr);
            const url = linkedPr.url ?? `https://github.com/${githubRepo}/pull/${linkedPr.number}`;
            return (
              <div
                key={linkedPr.number}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  padding: "2px 0",
                  minWidth: 0,
                }}
              >
                <span style={{ color: "var(--color-complete)", flexShrink: 0 }}>&#8853;</span>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--color-info)", fontSize: 12, flexShrink: 0 }}
                >
                  #{linkedPr.number}
                </a>
                {linkedPr.title && (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--color-text)",
                    }}
                  >
                    {linkedPr.title}
                  </span>
                )}
                {linkedPr.state && (
                  <span style={prStateStyle(linkedPr.state)}>{formatPrState(linkedPr.state)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
