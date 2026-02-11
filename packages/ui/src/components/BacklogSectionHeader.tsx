import React from "react";

interface BacklogSectionHeaderProps {
  isCollapsed: boolean;
  totalCount: number;
  onToggle: () => void;
}

export function BacklogSectionHeader({ isCollapsed, totalCount, onToggle }: BacklogSectionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!isCollapsed}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 8px",
        cursor: "pointer",
        background: "#f5f5f5",
        borderTop: "1px solid #e0e0e0",
        borderBottom: "1px solid #e0e0e0",
        borderLeft: "none",
        borderRight: "none",
        height: 28,
        fontSize: 12,
        fontWeight: 600,
        color: "#666",
        userSelect: "none",
        width: "100%",
        textAlign: "left",
      }}
    >
      <span style={{ width: 16, textAlign: "center", fontSize: 10 }}>
        {isCollapsed ? "\u25B6" : "\u25BC"}
      </span>
      <span>Backlog</span>
      <span style={{ color: "#999", fontWeight: 400 }}>({totalCount})</span>
    </button>
  );
}
