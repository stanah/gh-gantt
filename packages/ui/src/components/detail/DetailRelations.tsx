import React from "react";
import type { Dependency, Task } from "../../types/index.js";

interface DetailRelationsProps {
  blockedBy: Dependency[];
  linkedPrs: number[];
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
          {linkedPrs.map((pr) => (
            <div
              key={pr}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "2px 0",
              }}
            >
              <span style={{ color: "var(--color-complete)", flexShrink: 0 }}>&#8853;</span>
              <a
                href={`https://github.com/${githubRepo}/pull/${pr}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--color-info)", fontSize: 12 }}
              >
                #{pr}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
