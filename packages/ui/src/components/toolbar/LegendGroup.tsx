// packages/ui/src/components/toolbar/LegendGroup.tsx
import React, { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";
import type { SprintConfig } from "@gh-gantt/shared";
import type { TaskType } from "../../types/index.js";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";

interface LegendGroupProps {
  taskTypes: Record<string, TaskType>;
  sprints?: SprintConfig[];
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

function isCurrentSprint(sprint: SprintConfig): boolean {
  const now = new Date();
  const [sy, sm, sd] = sprint.start_date.split("-").map(Number);
  const [ey, em, ed] = sprint.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed, 23, 59, 59);
  return now >= start && now <= end;
}

export function LegendGroup({ taskTypes, sprints }: LegendGroupProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const entries = Object.entries(taskTypes);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <ToolbarGroup>
      <div ref={wrapperRef} style={{ position: "relative" }}>
        <IconButton
          icon={<Palette size={14} />}
          title="Task Type Legend"
          onClick={() => setOpen((prev) => !prev)}
          active={open}
          aria-haspopup="dialog"
          aria-expanded={open}
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
            {sprints && sprints.length > 0 && (
              <>
                <div
                  style={{
                    borderTop: "1px solid var(--color-border, #ddd)",
                    margin: "6px 0",
                  }}
                />
                <div style={{ ...itemStyle, fontWeight: 600, marginBottom: 6 }}>
                  <span>Sprints</span>
                </div>
                {sprints.map((sprint, i) => {
                  const current = isCurrentSprint(sprint);
                  return (
                    <div key={`${sprint.name}-${i}`} style={itemStyle}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: sprint.color ?? "#3b82f6",
                          opacity: current ? 1 : 0.3,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ opacity: current ? 1 : 0.6 }}>
                        {sprint.name}
                        {current ? " (current)" : ""}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </ToolbarGroup>
  );
}
