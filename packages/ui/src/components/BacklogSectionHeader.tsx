import React from "react";

interface BacklogSectionHeaderProps {
  isCollapsed: boolean;
  totalCount: number;
  onToggle: () => void;
}

export function BacklogSectionHeader({
  isCollapsed,
  totalCount,
  onToggle,
}: BacklogSectionHeaderProps) {
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
        background: "var(--color-border-light)",
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)",
        borderLeft: "none",
        borderRight: "none",
        height: 28,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-text-secondary)",
        userSelect: "none",
        width: "100%",
        textAlign: "left",
      }}
    >
      <span style={{ width: 16, textAlign: "center", fontSize: 10 }}>
        {isCollapsed ? "\u25B6" : "\u25BC"}
      </span>
      <span>Backlog</span>
      <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>({totalCount})</span>
    </button>
  );
}
