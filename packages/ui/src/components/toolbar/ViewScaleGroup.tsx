import React from "react";
import type { ViewScale } from "../../hooks/useGanttScale.js";
import { ToolbarGroup } from "./ToolbarGroup.js";

interface ViewScaleGroupProps {
  viewScale: ViewScale;
  onSetViewScale: (scale: ViewScale) => void;
}

const SCALES: { key: ViewScale; label: string }[] = [
  { key: "day", label: "D" },
  { key: "week", label: "W" },
  { key: "month", label: "M" },
  { key: "quarter", label: "Q" },
];

export function ViewScaleGroup({ viewScale, onSetViewScale }: ViewScaleGroupProps) {
  return (
    <ToolbarGroup label="View" gap={0}>
      <div style={{ display: "flex", gap: 1, background: "#f0f0f0", borderRadius: 4, padding: 1 }}>
        {SCALES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => onSetViewScale(key)}
            style={{
              padding: "3px 8px",
              border: "none",
              borderRadius: 3,
              background: viewScale === key ? "#333" : "transparent",
              color: viewScale === key ? "#fff" : "#555",
              cursor: "pointer",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </ToolbarGroup>
  );
}
