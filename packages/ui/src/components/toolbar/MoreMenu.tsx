import React, { useEffect, useRef, useState } from "react";
import { Settings, Hash, User, Signal, Keyboard } from "lucide-react";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import type { SprintConfig } from "@gh-gantt/shared";
import type { TaskType } from "../../types/index.js";
import { IconButton } from "./IconButton.js";

interface MoreMenuProps {
  displayOptions: Set<DisplayOption>;
  onToggleDisplayOption: (opt: DisplayOption) => void;
  taskTypes: Record<string, TaskType>;
  sprints?: SprintConfig[];
  onOpenShortcuts?: () => void;
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
  return (
    <svg width={16} height={10} aria-hidden="true">
      <rect x={0} y={1} width={16} height={8} rx={2} fill="currentColor" opacity={0.7} />
    </svg>
  );
}

function isCurrentSprint(sprint: SprintConfig): boolean {
  const now = new Date();
  return now >= new Date(sprint.start_date) && now <= new Date(sprint.end_date);
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 20,
  minWidth: 200,
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
  padding: 8,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 9,
  color: "var(--color-text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 4,
  userSelect: "none",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "var(--color-text-secondary)",
  marginBottom: 4,
};

const separator: React.CSSProperties = {
  borderTop: "1px solid var(--color-border-light)",
  margin: "6px 0",
};

export function MoreMenu({
  displayOptions,
  onToggleDisplayOption,
  taskTypes,
  sprints,
  onOpenShortcuts,
}: MoreMenuProps) {
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

  const toggleItems: Array<{ key: DisplayOption; icon: React.ReactNode; label: string }> = [
    { key: "issueId", icon: <Hash size={12} />, label: "Issue ID" },
    { key: "assignees", icon: <User size={12} />, label: "Assignees" },
    { key: "priority", icon: <Signal size={12} />, label: "Priority" },
  ];

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <IconButton
        icon={<Settings size={14} />}
        title="Display & Legend"
        onClick={() => setOpen((prev) => !prev)}
        active={open}
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      {open && (
        <div role="dialog" aria-label="Display & Legend" style={panelStyle}>
          {/* Display toggles */}
          <div style={sectionLabel}>Display</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 2 }}>
            {toggleItems.map((item) => {
              const active = displayOptions.has(item.key);
              return (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => onToggleDisplayOption(item.key)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 10px",
                    fontSize: 11,
                    border: `1px solid ${active ? "var(--color-selected-border)" : "var(--color-border)"}`,
                    borderRadius: 12,
                    background: active ? "var(--color-selected-bg)" : "var(--color-bg)",
                    color: active ? "var(--color-selected-fg)" : "var(--color-text)",
                    cursor: "pointer",
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div style={separator} />
          <div style={sectionLabel}>Legend</div>
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
              <div style={{ ...separator, margin: "4px 0" }} />
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

          {/* Shortcuts */}
          {onOpenShortcuts && (
            <>
              <div style={separator} />
              <button
                type="button"
                onClick={() => {
                  onOpenShortcuts();
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "4px 6px",
                  border: "none",
                  borderRadius: 3,
                  background: "transparent",
                  color: "var(--color-text)",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                <Keyboard size={12} />
                Keyboard Shortcuts
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
