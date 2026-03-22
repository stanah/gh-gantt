import React, { useMemo, useState } from "react";
import { PRIORITY_LEVELS } from "./PriorityBadge.js";

export const NO_PRIORITY = "__no_priority__";

interface PriorityFilterProps {
  selectedValues: string[];
  onChange: (values: string[]) => void;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function formatLabel(values: string[]): string {
  if (values.length === 0) return "All priorities";
  const readable = values.map((v) => (v === NO_PRIORITY ? "No priority" : v));
  if (readable.length <= 2) return readable.join(", ");
  return `${readable[0]}, ${readable[1]} +${readable.length - 2}`;
}

export function PriorityFilter({ selectedValues, onChange }: PriorityFilterProps) {
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  const btnStyle: React.CSSProperties = {
    padding: "3px 8px",
    border: "1px solid #ccc",
    borderRadius: 3,
    background: selectedValues.length > 0 ? "#333" : "#fff",
    color: selectedValues.length > 0 ? "#fff" : "#333",
    cursor: "pointer",
    fontSize: 11,
    minWidth: 120,
    textAlign: "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const menuStyle: React.CSSProperties = {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 20,
    minWidth: 180,
    maxHeight: 260,
    overflow: "auto",
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    padding: 8,
  };

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((prev) => !prev)} style={btnStyle} title={formatLabel(selectedValues)}>
        {formatLabel(selectedValues)}
      </button>
      {open && (
        <div style={menuStyle}>
          <button
            onClick={() => onChange([])}
            style={{
              width: "100%",
              padding: "4px 6px",
              border: "1px solid #ddd",
              borderRadius: 3,
              background: selectedValues.length === 0 ? "#f0f4ff" : "#fff",
              cursor: "pointer",
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            Clear (All priorities)
          </button>

          {PRIORITY_LEVELS.map((level) => (
            <label key={level} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedSet.has(level)}
                onChange={() => onChange(toggleValue(selectedValues, level))}
              />
              {level}
            </label>
          ))}

          <div style={{ borderTop: "1px solid #f0f0f0", margin: "6px 0", paddingTop: 6 }} />

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={selectedSet.has(NO_PRIORITY)}
              onChange={() => onChange(toggleValue(selectedValues, NO_PRIORITY))}
            />
            No priority
          </label>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              onClick={() => setOpen(false)}
              style={{
                padding: "3px 10px",
                border: "1px solid #ccc",
                borderRadius: 3,
                background: "#fff",
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
