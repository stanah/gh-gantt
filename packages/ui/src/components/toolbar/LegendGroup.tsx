// packages/ui/src/components/toolbar/LegendGroup.tsx
import React, { useState } from "react";
import { Palette } from "lucide-react";
import type { TaskType } from "../../types/index.js";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";

interface LegendGroupProps {
  taskTypes: Record<string, TaskType>;
}

function DisplayIcon({ display }: { display: TaskType["display"] }) {
  if (display === "summary") {
    return (
      <svg width={16} height={10} aria-hidden="true">
        <rect x={0} y={3} width={16} height={4} rx={1} fill="currentColor" opacity={0.5} />
        <rect x={0} y={1} width={3} height={8} fill="currentColor" />
        <rect x={13} y={1} width={3} height={8} fill="currentColor" />
      </svg>
    );
  }
  if (display === "milestone") {
    return (
      <svg width={12} height={12} aria-hidden="true">
        <polygon points="6,0 12,6 6,12 0,6" fill="currentColor" opacity={0.7} />
      </svg>
    );
  }
  // bar (default)
  return (
    <svg width={16} height={10} aria-hidden="true">
      <rect x={0} y={1} width={16} height={8} rx={2} fill="currentColor" opacity={0.7} />
    </svg>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 20,
  minWidth: 180,
  background: "var(--color-surface, #fff)",
  border: "1px solid var(--color-border, #ddd)",
  borderRadius: 4,
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
  padding: 8,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  marginBottom: 4,
  color: "var(--color-text-secondary, #555)",
};

export function LegendGroup({ taskTypes }: LegendGroupProps) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(taskTypes);

  return (
    <ToolbarGroup label="Legend">
      <div style={{ position: "relative" }}>
        <IconButton
          icon={<Palette size={14} />}
          title="Task Type Legend"
          onClick={() => setOpen((prev) => !prev)}
          active={open}
        />
        {open && (
          <div role="dialog" aria-label="Task type legend" style={panelStyle}>
            {entries.map(([name, def]) => (
              <div key={name} style={itemStyle}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: def.display === "milestone" ? 0 : "50%",
                    transform: def.display === "milestone" ? "rotate(45deg)" : undefined,
                    background: def.color,
                    flexShrink: 0,
                  }}
                />
                <DisplayIcon display={def.display} />
                <span>{def.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ToolbarGroup>
  );
}
