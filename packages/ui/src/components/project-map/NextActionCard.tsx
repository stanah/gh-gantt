import React from "react";
import type { NextAction, NextActionCategory } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";

interface NextActionCardProps {
  action: NextAction;
  config: Config;
  index: number;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
}

const CATEGORY_COLOR: Record<NextActionCategory, string> = {
  unlocker: "#2ecc71",
  critical: "#e74c3c",
  risk: "#f39c12",
  review_waiting: "#9b59b6",
  quick_win: "#3498db",
  ready: "#8b949e",
};

/**
 * Next Actions の 1 候補カード。順位・タイトル・推薦理由（カテゴリ色付き）を表示し、
 * クリック / Enter / Space で対象タスクを選択する。
 */
export function NextActionCard({
  action,
  config,
  index,
  isSelected,
  onSelect,
}: NextActionCardProps) {
  const { task } = action;
  const typeColor = config.task_types[task.type]?.color ?? "var(--color-text-muted)";
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
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        marginBottom: 6,
        border: `1px solid ${isSelected ? "var(--color-selected-border, #4285f4)" : "var(--color-border)"}`,
        borderRadius: 4,
        background: isSelected ? "rgba(66, 133, 244, 0.1)" : "var(--color-bg)",
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "var(--color-text-muted)",
          flexShrink: 0,
        }}
      >
        {index + 1}
      </span>
      <span
        style={{ width: 8, height: 8, borderRadius: 2, background: typeColor, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--color-text)",
            fontWeight: 500,
          }}
          title={task.title}
        >
          {task.github_issue != null && (
            <span style={{ color: "var(--color-text-muted)", marginRight: 4 }}>
              #{task.github_issue}
            </span>
          )}
          {task.title}
        </div>
        <div style={{ marginTop: 2, color: CATEGORY_COLOR[action.category], fontSize: 10 }}>
          {action.reason}
        </div>
      </div>
    </div>
  );
}
