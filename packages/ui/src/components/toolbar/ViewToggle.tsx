import React from "react";
import { GanttChartSquare, LayoutGrid } from "lucide-react";

export type AppViewMode = "gantt" | "project-map";

interface ViewToggleProps {
  viewMode: AppViewMode;
  onViewModeChange: (mode: AppViewMode) => void;
}

const OPTIONS: Array<{ value: AppViewMode; label: string; icon: React.ReactNode }> = [
  { value: "gantt", label: "Gantt", icon: <GanttChartSquare size={13} /> },
  { value: "project-map", label: "Project Map", icon: <LayoutGrid size={13} /> },
];

/**
 * Gantt ビューと Project Map ビューを切り替えるセグメント型トグル。
 */
export function ViewToggle({ viewMode, onViewModeChange }: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="View"
      style={{
        display: "inline-flex",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {OPTIONS.map((opt) => {
        const active = viewMode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onViewModeChange(opt.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              border: "none",
              fontSize: 11,
              cursor: "pointer",
              background: active ? "var(--color-accent, #4285f4)" : "var(--color-bg)",
              color: active ? "#fff" : "var(--color-text-secondary)",
              minHeight: 24,
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
