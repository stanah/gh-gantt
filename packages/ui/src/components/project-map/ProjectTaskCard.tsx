import React from "react";
import type { Task as SharedTask, TaskReadiness } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { getTaskProgress } from "./progress-util.js";

interface ProjectTaskCardProps {
  task: SharedTask;
  readiness?: TaskReadiness;
  config: Config;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  blockingTitles?: string[];
}

/**
 * Project Board / Next Actions で使うタスクカード。
 * issue 番号・タイトル・ラベル・優先度・assignee・進捗を表示し、
 * blocked の場合はブロック理由（上流タスク）を併記する。クリック / Enter / Space で選択。
 */
export function ProjectTaskCard({
  task,
  readiness,
  config,
  isSelected,
  onSelect,
  blockingTitles,
}: ProjectTaskCardProps) {
  const typeColor = config.task_types[task.type]?.color ?? "var(--color-text-muted)";
  const priorityField = config.sync?.field_mapping?.priority;
  const priority =
    priorityField && typeof task.custom_fields[priorityField] === "string"
      ? (task.custom_fields[priorityField] as string)
      : null;
  const progress = getTaskProgress(task);

  return (
    <div
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect(task.id);
      }}
      style={{
        border: `1px solid ${isSelected ? "var(--color-selected-border, #4285f4)" : "var(--color-border)"}`,
        borderLeft: `3px solid ${typeColor}`,
        borderRadius: 4,
        padding: "5px 7px",
        marginBottom: 6,
        background: isSelected ? "rgba(66, 133, 244, 0.1)" : "var(--color-bg)",
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {task.github_issue != null && (
          <span style={{ color: "var(--color-text-muted)", flexShrink: 0 }}>
            #{task.github_issue}
          </span>
        )}
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--color-text)",
            fontWeight: 500,
          }}
          title={task.title}
        >
          {task.title}
        </span>
        {priority && (
          <span style={{ fontSize: 9, color: "var(--color-text-muted)", flexShrink: 0 }}>
            {priority}
          </span>
        )}
      </div>
      {(task.labels.length > 0 || task.assignees.length > 0 || progress != null) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            flexWrap: "wrap",
            color: "var(--color-text-muted)",
            fontSize: 10,
          }}
        >
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: "0 6px",
              }}
            >
              {label}
            </span>
          ))}
          {task.assignees.length > 0 && <span>@{task.assignees.join(", @")}</span>}
          {progress != null && <span style={{ marginLeft: "auto" }}>{progress}%</span>}
        </div>
      )}
      {readiness && readiness.isBlocked && blockingTitles && blockingTitles.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10, color: "#e74c3c" }}>
          ⛔ {blockingTitles.join(", ")} 待ち
        </div>
      )}
    </div>
  );
}
