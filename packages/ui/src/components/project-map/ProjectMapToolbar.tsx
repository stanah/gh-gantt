import React from "react";
import type { BoardColumnId, GroupDimension, GroupDimensionOption } from "@gh-gantt/shared";
import type { SyncStatus } from "../../hooks/useSyncStatus.js";
import { boardColumnColor, boardColumnLabel } from "./ReadinessBadge.js";

export interface ProjectMapFilterState {
  search: string;
  readiness: BoardColumnId | null;
}

interface ProjectMapToolbarProps {
  filter: ProjectMapFilterState;
  onChange: (filter: ProjectMapFilterState) => void;
  groupDimension: GroupDimension;
  onGroupDimensionChange: (dimension: GroupDimension) => void;
  groupDimensions: GroupDimensionOption[];
  syncStatus: SyncStatus | null;
  matchedCount: number;
  totalCount: number;
}

const READINESS_OPTIONS: BoardColumnId[] = [
  "ready_now",
  "in_progress",
  "review",
  "blocked",
  "done",
];

function formatSyncedAt(value: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value || "未同期";
  return new Date(t).toLocaleString();
}

/**
 * Project Map のツールバー。タイトル検索・readiness クイックフィルタを提供し、
 * 同期状態（last_synced_at / local_changes / total_tasks）を表示する。
 * フィルタは Tree / Board / Next Actions / Timeline に一貫適用される。
 */
export function ProjectMapToolbar({
  filter,
  onChange,
  groupDimension,
  onGroupDimensionChange,
  groupDimensions,
  syncStatus,
  matchedCount,
  totalCount,
}: ProjectMapToolbarProps) {
  const setReadiness = (column: BoardColumnId | null) => onChange({ ...filter, readiness: column });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        fontSize: 11,
        flexWrap: "wrap",
      }}
    >
      <input
        type="search"
        aria-label="Project Map 検索"
        placeholder="タスクを検索…"
        value={filter.search}
        onChange={(e) => onChange({ ...filter, search: e.target.value })}
        style={{
          padding: "3px 8px",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          fontSize: 11,
          minHeight: 24,
          background: "var(--color-bg)",
          color: "var(--color-text)",
          minWidth: 160,
        }}
      />
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
        <span style={{ color: "var(--color-text-muted)" }}>Group by</span>
        <select
          aria-label="Group by 軸"
          value={groupDimension}
          onChange={(e) => onGroupDimensionChange(e.target.value as GroupDimension)}
          style={{
            padding: "3px 6px",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            fontSize: 11,
            minHeight: 24,
            background: "var(--color-bg)",
            color: "var(--color-text)",
          }}
        >
          {groupDimensions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="Readiness フィルタ" style={{ display: "flex", gap: 4 }}>
        <FilterChip
          active={filter.readiness === null}
          onClick={() => setReadiness(null)}
          label="All"
        />
        {READINESS_OPTIONS.map((column) => (
          <FilterChip
            key={column}
            active={filter.readiness === column}
            onClick={() => setReadiness(filter.readiness === column ? null : column)}
            label={boardColumnLabel(column)}
            color={boardColumnColor(column)}
          />
        ))}
      </div>
      <span style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
        {matchedCount}/{totalCount} 件
      </span>
      <div style={{ flex: 1 }} />
      {syncStatus && (
        <span
          style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap" }}
          title={`最終同期: ${formatSyncedAt(syncStatus.last_synced_at)}`}
        >
          同期: {formatSyncedAt(syncStatus.last_synced_at)} ・ 未反映 {syncStatus.local_changes} ・
          全{syncStatus.total_tasks}
        </span>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        border: `1px solid ${active ? "var(--color-accent, #4285f4)" : "var(--color-border)"}`,
        borderRadius: 10,
        fontSize: 10,
        cursor: "pointer",
        background: active ? "rgba(66, 133, 244, 0.12)" : "var(--color-bg)",
        color: "var(--color-text-secondary)",
      }}
    >
      {color && (
        <span
          style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }}
        />
      )}
      {label}
    </button>
  );
}
