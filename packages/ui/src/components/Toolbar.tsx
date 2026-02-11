import React from "react";
import type { ViewScale } from "../hooks/useGanttScale.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";

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
  searchQuery: string;
  onSearchChange: (query: string) => void;
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
  searchQuery,
  onSearchChange,
}: ToolbarProps) {

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
        <button onClick={onToggleHideClosed} style={btnStyle(hideClosed)}>
          Hide closed
        </button>
        <select
          value={selectedAssignee ?? ""}
          onChange={(e) => onSelectAssignee(e.target.value || null)}
          style={{
            padding: "3px 6px",
            border: "1px solid #ccc",
            borderRadius: 3,
            fontSize: 11,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          <option value="">All assignees</option>
          <option value="__unassigned__">Unassigned</option>
          {allAssignees.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div style={{ width: 1, height: 20, background: "#e0e0e0" }} />

      {/* Search */}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tasks..."
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
