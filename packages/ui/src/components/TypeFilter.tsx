import React, { useEffect, useMemo, useRef, useState } from "react";
import { Tags } from "lucide-react";
import type { TaskType } from "../types/index.js";

interface TypeFilterProps {
  taskTypes: Record<string, TaskType>;
  enabled: Set<string>;
  onToggle: (typeName: string) => void;
}

function formatLabel(
  enabled: Set<string>,
  total: number,
  taskTypes: Record<string, TaskType>,
): string {
  if (enabled.size === total || enabled.size === 0) return "All types";
  if (enabled.size === 1) {
    const [name] = enabled;
    return taskTypes[name]?.label ?? name;
  }
  return `${enabled.size} types`;
}

export function TypeFilter({ taskTypes, enabled, onToggle }: TypeFilterProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => Object.entries(taskTypes), [taskTypes]);
  const allCount = entries.length;
  const isFiltered = enabled.size < allCount && enabled.size > 0;

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

  const btnStyle: React.CSSProperties = {
    padding: "4px 8px",
    border: `1px solid ${isFiltered ? "var(--color-selected-border)" : "var(--color-border)"}`,
    borderRadius: 3,
    background: isFiltered ? "var(--color-selected-bg)" : "var(--color-surface)",
    color: isFiltered ? "var(--color-selected-fg)" : "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: 11,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    lineHeight: 1,
  };

  const menuStyle: React.CSSProperties = {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 20,
    minWidth: 180,
    maxHeight: 260,
    overflow: "auto",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    padding: 8,
  };

  const badgeStyle: React.CSSProperties = {
    background: "var(--color-selected-fg)",
    color: "#fff",
    borderRadius: 8,
    padding: "0 5px",
    fontSize: 9,
    minWidth: 16,
    textAlign: "center",
    lineHeight: "16px",
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={btnStyle}
        title={formatLabel(enabled, allCount, taskTypes)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Tags size={12} />
        {formatLabel(enabled, allCount, taskTypes)}
        {isFiltered && <span style={badgeStyle}>{enabled.size}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Filter by type" style={menuStyle}>
          <button
            type="button"
            onClick={() => {
              for (const [name] of entries) {
                if (!enabled.has(name)) onToggle(name);
              }
            }}
            style={{
              width: "100%",
              padding: "4px 6px",
              border: "1px solid var(--color-border)",
              borderRadius: 3,
              background:
                enabled.size === allCount ? "var(--color-hover-bg)" : "var(--color-surface)",
              cursor: "pointer",
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            Enable All
          </button>

          {entries.map(([name, def]) => {
            const isLast = enabled.size === 1 && enabled.has(name);
            return (
              <label
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  marginBottom: 6,
                  cursor: isLast ? "not-allowed" : "pointer",
                  opacity: isLast ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled.has(name)}
                  disabled={isLast}
                  onChange={() => onToggle(name)}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: def.color,
                    flexShrink: 0,
                  }}
                />
                {def.label}
              </label>
            );
          })}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                padding: "3px 10px",
                border: "1px solid #ccc",
                borderRadius: 3,
                background: "var(--color-surface)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
