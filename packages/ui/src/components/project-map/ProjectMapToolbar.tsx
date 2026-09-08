import React from "react";
import type { BoardColumnId, GroupDimension, GroupDimensionOption } from "@gh-gantt/shared";
import type { SyncStatus } from "../../hooks/useSyncStatus.js";
import { boardColumnColor, boardColumnLabel } from "./ReadinessBadge.js";
import { MILESTONE_NONE_KEY, type ProjectMapFilterState } from "./filter-util.js";

export type { ProjectMapFilterState } from "./filter-util.js";

/** タイプ絞り込みチップの 1 選択肢（config.task_types 由来）。 */
export interface ProjectMapTypeOption {
  value: string;
  label: string;
  color: string;
}

interface ProjectMapToolbarProps {
  filter: ProjectMapFilterState;
  onChange: (filter: ProjectMapFilterState) => void;
  /** タイプ絞り込みの選択肢。空なら タイプ フィルタを表示しない。 */
  typeOptions?: ProjectMapTypeOption[];
  /** マイルストーン絞り込みの選択肢（名前の一覧）。空なら マイルストーン フィルタを表示しない。 */
  milestoneOptions?: string[];
  /** マイルストーン型のタスクが存在するか。true なら「マイルストーン型を表示」トグルを出す。 */
  hasMilestoneTypes?: boolean;
  groupDimension: GroupDimension;
  onGroupDimensionChange: (dimension: GroupDimension) => void;
  groupDimensions: GroupDimensionOption[];
  syncStatus: SyncStatus | null;
  matchedCount: number;
  totalCount: number;
  /** パネル構成の設定 UI が開いているか。 */
  layoutSettingsOpen?: boolean;
  /** パネル設定ボタンの押下ハンドラ。未指定ならボタンを表示しない。 */
  onToggleLayoutSettings?: () => void;
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

/** 配列内の値をトグルする（あれば除去、なければ末尾に追加）。 */
function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/**
 * Project Map のツールバー。タイトル検索・readiness クイックフィルタ（複数選択）・
 * Done 除外トグル・タスクタイプ絞り込み（複数選択）・マイルストーン絞り込み（複数選択、
 * 祖先からの継承つき）・マイルストーン型ノードの表示トグルを提供し、
 * 同期状態（last_synced_at / local_changes / total_tasks）を表示する。
 * パネル構成の設定 UI を開閉する「パネル設定」ボタンの入口も担う。
 * フィルタは Tree / Board / Next Actions / Timeline / Dependency Map に一貫適用される。
 */
export function ProjectMapToolbar({
  filter,
  onChange,
  typeOptions = [],
  milestoneOptions = [],
  hasMilestoneTypes = false,
  groupDimension,
  onGroupDimensionChange,
  groupDimensions,
  syncStatus,
  matchedCount,
  totalCount,
  layoutSettingsOpen = false,
  onToggleLayoutSettings,
}: ProjectMapToolbarProps) {
  const readinessAll = filter.readiness.length === 0 && !filter.excludeDone;
  // All: readiness の選択と Done 除外をまとめて解除する
  const clearReadiness = () => onChange({ ...filter, readiness: [], excludeDone: false });
  const toggleReadiness = (column: BoardColumnId) =>
    onChange({
      ...filter,
      readiness: toggleValue(filter.readiness, column),
      // Done を明示的に選んだら除外トグルは解除する
      excludeDone:
        column === "done" && !filter.readiness.includes("done") ? false : filter.excludeDone,
    });
  const toggleExcludeDone = () =>
    onChange({
      ...filter,
      excludeDone: !filter.excludeDone,
      // 除外を有効にしたら Done の選択は外す
      readiness: filter.excludeDone
        ? filter.readiness
        : filter.readiness.filter((c) => c !== "done"),
    });
  const toggleType = (type: string) =>
    onChange({ ...filter, types: toggleValue(filter.types, type) });
  const toggleMilestone = (name: string) =>
    onChange({ ...filter, milestones: toggleValue(filter.milestones, name) });

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
        <FilterChip active={readinessAll} onClick={clearReadiness} label="All" />
        {READINESS_OPTIONS.map((column) => (
          <FilterChip
            key={column}
            active={filter.readiness.includes(column)}
            onClick={() => toggleReadiness(column)}
            label={boardColumnLabel(column)}
            color={boardColumnColor(column)}
          />
        ))}
        <FilterChip
          active={filter.excludeDone}
          onClick={toggleExcludeDone}
          label="Done を除外"
          title="Done 列のタスクを非表示にする"
        />
      </div>
      {typeOptions.length > 0 && (
        <div role="group" aria-label="タイプ フィルタ" style={{ display: "flex", gap: 4 }}>
          <FilterChip
            active={filter.types.length === 0}
            onClick={() => onChange({ ...filter, types: [] })}
            label="All"
          />
          {typeOptions.map((opt) => (
            <FilterChip
              key={opt.value}
              active={filter.types.includes(opt.value)}
              onClick={() => toggleType(opt.value)}
              label={opt.label}
              color={opt.color}
            />
          ))}
        </div>
      )}
      {milestoneOptions.length > 0 && (
        <div role="group" aria-label="マイルストーン フィルタ" style={{ display: "flex", gap: 4 }}>
          <FilterChip
            active={filter.milestones.length === 0}
            onClick={() => onChange({ ...filter, milestones: [] })}
            label="All"
          />
          {milestoneOptions.map((name) => (
            <FilterChip
              key={name}
              active={filter.milestones.includes(name)}
              onClick={() => toggleMilestone(name)}
              label={name}
              title="祖先にこのマイルストーンが設定された子孫タスクも含む"
            />
          ))}
          <FilterChip
            active={filter.milestones.includes(MILESTONE_NONE_KEY)}
            onClick={() => toggleMilestone(MILESTONE_NONE_KEY)}
            label="(なし)"
            title="自身にも祖先にもマイルストーンが無いタスク"
          />
        </div>
      )}
      {hasMilestoneTypes && (
        <FilterChip
          active={filter.showMilestoneTypes}
          onClick={() => onChange({ ...filter, showMilestoneTypes: !filter.showMilestoneTypes })}
          label="マイルストーン型を表示"
          title="マイルストーン型のタスクを Dependency Map のノードとして表示する（ひし形で区別）"
        />
      )}
      <span style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
        {matchedCount}/{totalCount} 件
      </span>
      <div style={{ flex: 1 }} />
      {onToggleLayoutSettings && (
        <button
          type="button"
          aria-label="パネル設定"
          aria-expanded={layoutSettingsOpen}
          onClick={onToggleLayoutSettings}
          style={{
            padding: "2px 8px",
            border: `1px solid ${layoutSettingsOpen ? "var(--color-accent, #4285f4)" : "var(--color-border)"}`,
            borderRadius: 4,
            fontSize: 11,
            minHeight: 24,
            cursor: "pointer",
            background: layoutSettingsOpen ? "rgba(66, 133, 244, 0.12)" : "var(--color-bg)",
            color: "var(--color-text-secondary)",
            whiteSpace: "nowrap",
          }}
        >
          パネル設定
        </button>
      )}
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
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
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
