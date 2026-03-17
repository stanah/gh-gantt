import React, { useMemo, useState } from "react";
import { UNASSIGNED } from "../hooks/useTaskFilter.js";

interface AssigneeFilterProps {
  assignees: string[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function formatLabel(values: string[]): string {
  if (values.length === 0) return "All assignees";
  const readable = values.map((v) => (v === UNASSIGNED ? "Unassigned" : `@${v}`));
  if (readable.length <= 2) return readable.join(", ");
  return `${readable[0]}, ${readable[1]} +${readable.length - 2}`;
}

export function AssigneeFilter({ assignees, selectedValues, onChange }: AssigneeFilterProps) {
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
    minWidth: 150,
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
    minWidth: 220,
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
            Clear (All assignees)
          </button>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={selectedSet.has(UNASSIGNED)}
              onChange={() => onChange(toggleValue(selectedValues, UNASSIGNED))}
            />
            Unassigned
          </label>

          <div style={{ borderTop: "1px solid #f0f0f0", margin: "6px 0", paddingTop: 6 }} />

          {assignees.map((assignee) => (
            <label key={assignee} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginBottom: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedSet.has(assignee)}
                onChange={() => onChange(toggleValue(selectedValues, assignee))}
              />
              @{assignee}
            </label>
          ))}

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
