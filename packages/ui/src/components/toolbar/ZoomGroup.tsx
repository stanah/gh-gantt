import React from "react";
import { CalendarDays } from "lucide-react";
import type { ViewScale } from "@gh-gantt/shared";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";

const SCALES: { value: ViewScale; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

interface ZoomGroupProps {
  activeScale: ViewScale;
  onScaleChange: (scale: ViewScale) => void;
  onScrollToToday: () => void;
}

export function ZoomGroup({ activeScale, onScaleChange, onScrollToToday }: ZoomGroupProps) {
  return (
    <ToolbarGroup>
      <div style={{ display: "flex", gap: 0 }}>
        {SCALES.map((s, i) => (
          <button
            key={s.value}
            onClick={() => onScaleChange(s.value)}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              border: "1px solid var(--color-border)",
              borderRight: i < SCALES.length - 1 ? "none" : "1px solid var(--color-border)",
              borderRadius: i === 0 ? "3px 0 0 3px" : i === SCALES.length - 1 ? "0 3px 3px 0" : 0,
              background: activeScale === s.value ? "var(--color-accent)" : "var(--color-surface)",
              color: activeScale === s.value ? "#fff" : "var(--color-text-secondary)",
              cursor: "pointer",
              lineHeight: "20px",
            }}
            title={s.label}
          >
            {s.label}
          </button>
        ))}
      </div>
      <IconButton
        icon={<CalendarDays size={14} />}
        title="Scroll to Today"
        onClick={onScrollToToday}
      />
    </ToolbarGroup>
  );
}
