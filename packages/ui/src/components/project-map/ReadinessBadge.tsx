import React from "react";
import type { BoardColumnId, TaskReadiness } from "@gh-gantt/shared";

const COLUMN_LABEL: Record<BoardColumnId, string> = {
  ready_now: "Ready",
  in_progress: "In Progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  backlog: "Backlog",
};

const COLUMN_COLOR: Record<BoardColumnId, string> = {
  ready_now: "#2ecc71",
  in_progress: "#f39c12",
  review: "#9b59b6",
  blocked: "#e74c3c",
  done: "#8957e5",
  backlog: "#8b949e",
};

/** Board 列 ID の表示ラベルを返す。 */
export function boardColumnLabel(column: BoardColumnId): string {
  return COLUMN_LABEL[column];
}

/** Board 列 ID の代表色を返す。 */
export function boardColumnColor(column: BoardColumnId): string {
  return COLUMN_COLOR[column];
}

/**
 * タスクの readiness を小さなバッジで表示する。
 * 列に応じた色とラベルに加え、クリティカル / リスクのマーカーを付す。
 */
export function ReadinessBadge({ readiness }: { readiness: TaskReadiness }) {
  const color = COLUMN_COLOR[readiness.column];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
      <span
        title={COLUMN_LABEL[readiness.column]}
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: "#fff",
          background: color,
          borderRadius: 3,
          padding: "1px 5px",
          whiteSpace: "nowrap",
        }}
      >
        {COLUMN_LABEL[readiness.column]}
      </span>
      {readiness.isCritical && (
        <span title="クリティカルパス上" style={{ fontSize: 10, color: "#e74c3c" }}>
          ▲
        </span>
      )}
      {readiness.isRisky && (
        <span title="高リスク" style={{ fontSize: 10, color: "#f39c12" }}>
          ⚠
        </span>
      )}
    </span>
  );
}
