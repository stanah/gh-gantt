import React, { useState, useCallback } from "react";
import type { ViewScale } from "../hooks/useGanttScale.js";

interface ToolbarProps {
  viewScale: ViewScale;
  onSetViewScale: (scale: ViewScale) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onScrollToToday: () => void;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  lastSyncedAt?: string;
}

export function Toolbar({
  viewScale,
  onSetViewScale,
  onZoomIn,
  onZoomOut,
  onScrollToToday,
  onPull,
  onPush,
  lastSyncedAt,
}: ToolbarProps) {
  const [syncing, setSyncing] = useState(false);

  const handlePull = useCallback(async () => {
    setSyncing(true);
    try { await onPull(); } finally { setSyncing(false); }
  }, [onPull]);

  const handlePush = useCallback(async () => {
    setSyncing(true);
    try { await onPush(); } finally { setSyncing(false); }
  }, [onPush]);

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

      <div style={{ flex: 1 }} />

      {/* Sync */}
      <button onClick={handlePull} disabled={syncing} style={{ ...btnStyle(), opacity: syncing ? 0.5 : 1 }}>
        Pull
      </button>
      <button onClick={handlePush} disabled={syncing} style={{ ...btnStyle(), opacity: syncing ? 0.5 : 1 }}>
        Push
      </button>

      {lastSyncedAt && (
        <span style={{ color: "#888", fontSize: 10 }}>
          Last sync: {new Date(lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
