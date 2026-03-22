import React from "react";
import type { ViewScale } from "../hooks/useGanttScale.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";
import { AssigneeFilter } from "./AssigneeFilter.js";
import { PriorityFilter } from "./PriorityFilter.js";

interface ToolbarProps {
  viewScale: ViewScale;
  onSetViewScale: (scale: ViewScale) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onScrollToToday: () => void;
  onPull: () => void;
  onPush: () => void;
  syncing: "pull" | "push" | null;
  lastSyncedAt?: string;
  displayOptions: Set<DisplayOption>;
  onToggleDisplayOption: (opt: DisplayOption) => void;
  hideClosed: boolean;
  onToggleHideClosed: () => void;
  selectedAssignee: string | null;
  allAssignees: string[];
  onSelectAssignee: (assignee: string | null) => void;
  selectedPriorities?: string[];
  onSelectPriorities?: (values: string[]) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  onOpenShortcuts?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoCount?: number;
  redoCount?: number;
  undoRedoBusy?: boolean;
}

export function Toolbar({
  viewScale,
  onSetViewScale,
  onZoomIn,
  onZoomOut,
  onScrollToToday,
  onPull,
  onPush,
  syncing,
  lastSyncedAt,
  displayOptions,
  onToggleDisplayOption,
  hideClosed,
  onToggleHideClosed,
  selectedAssignee,
  allAssignees,
  onSelectAssignee,
  selectedPriorities,
  onSelectPriorities,
  searchQuery,
  onSearchChange,
  searchInputRef,
  onOpenShortcuts,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  undoCount = 0,
  redoCount = 0,
  undoRedoBusy = false,
}: ToolbarProps) {
  const selectedAssignees = selectedAssignee
    ? selectedAssignee
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    : [];

  const btnStyle = (active = false): React.CSSProperties => ({
    padding: "3px 10px",
    border: "1px solid #ccc",
    borderRadius: 3,
    background: active ? "#333" : "#fff",
    color: active ? "#fff" : "#333",
    cursor: "pointer",
    fontSize: 11,
  });

  return (
    <div style={{ padding: "6px 16px", borderBottom: "1px solid #e0e0e0", background: "#fff", display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
      {/* View scale */}
      <div style={{ display: "flex", gap: 2 }}>
        {(["day", "week", "month", "quarter"] as const).map((scale) => (
          <button key={scale} onClick={() => onSetViewScale(scale)} style={btnStyle(viewScale === scale)}>
            {scale}
          </button>
        ))}
      </div>

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Zoom */}
      <button onClick={onZoomIn} style={btnStyle()}>+</button>
      <button onClick={onZoomOut} style={btnStyle()}>-</button>
      <button onClick={onScrollToToday} style={btnStyle()}>Today</button>

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Display options */}
      <div style={{ display: "flex", gap: 2 }}>
        <button onClick={() => onToggleDisplayOption("issueId")} style={btnStyle(displayOptions.has("issueId"))}>
          #ID
        </button>
        <button onClick={() => onToggleDisplayOption("assignees")} style={btnStyle(displayOptions.has("assignees"))}>
          Assignee
        </button>
      </div>

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Filters */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button onClick={onToggleHideClosed} aria-pressed={hideClosed} style={btnStyle(hideClosed)}>
          Hide closed
        </button>
        <AssigneeFilter
          assignees={allAssignees}
          selectedValues={selectedAssignees}
          onChange={(values) => onSelectAssignee(values.length > 0 ? values.join(",") : null)}
        />
        {selectedPriorities && onSelectPriorities && (
          <PriorityFilter
            selectedValues={selectedPriorities}
            onChange={onSelectPriorities}
          />
        )}
      </div>

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Search */}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tasks..."
          aria-label="Search tasks"
          style={{
            padding: "3px 24px 3px 6px",
            border: "1px solid #ccc",
            borderRadius: 3,
            fontSize: 11,
            width: 160,
            outline: "none",
          }}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            style={{
              position: "absolute",
              right: 2,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              color: "#888",
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      {onOpenShortcuts && (
        <button
          onClick={onOpenShortcuts}
          style={btnStyle()}
          title="Show keyboard shortcuts"
          aria-label="Show keyboard shortcuts"
          aria-haspopup="dialog"
        >
          ?
        </button>
      )}

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Undo / Redo */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          onClick={onUndo}
          disabled={!onUndo || !canUndo || undoRedoBusy}
          style={{ ...btnStyle(), opacity: !onUndo || !canUndo || undoRedoBusy ? 0.5 : 1 }}
          title={`Undo (${undoCount})`}
        >
          Undo
          {undoCount > 0 ? ` ${undoCount}` : ""}
        </button>
        <button
          onClick={onRedo}
          disabled={!onRedo || !canRedo || undoRedoBusy}
          style={{ ...btnStyle(), opacity: !onRedo || !canRedo || undoRedoBusy ? 0.5 : 1 }}
          title={`Redo (${redoCount})`}
        >
          Redo
          {redoCount > 0 ? ` ${redoCount}` : ""}
        </button>
      </div>

      <div style={{ flex: 1 }} />

      {/* Sync */}
      <button onClick={onPull} disabled={!!syncing} style={{ ...btnStyle(), opacity: syncing ? 0.5 : 1 }}>
        {syncing === "pull" ? "Pulling…" : "Pull"}
      </button>
      <button onClick={onPush} disabled={!!syncing} style={{ ...btnStyle(), opacity: syncing ? 0.5 : 1 }}>
        {syncing === "push" ? "Pushing…" : "Push"}
      </button>

      {lastSyncedAt && (
        <span style={{ color: "#888", fontSize: 10 }}>
          Last sync: {new Date(lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
