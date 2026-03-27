import React, { useEffect, useMemo, useRef, useState } from "react";
import { NO_LABEL } from "../hooks/useTaskFilter.js";

interface LabelFilterProps {
  labels: string[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function formatLabel(values: string[]): string {
  if (values.length === 0) return "All labels";
  const readable = values.map((v) => (v === NO_LABEL ? "No label" : v));
  if (readable.length <= 2) return readable.join(", ");
  return `${readable[0]}, ${readable[1]} +${readable.length - 2}`;
}

export function LabelFilter({ labels, selectedValues, onChange }: LabelFilterProps) {
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const wrapperRef = useRef<HTMLDivElement>(null);

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
    padding: "3px 8px",
    border: "1px solid var(--color-border)",
    borderRadius: 3,
    background: selectedValues.length > 0 ? "var(--color-selected-bg)" : "var(--color-bg)",
    color: selectedValues.length > 0 ? "var(--color-selected-fg)" : "var(--color-text)",
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
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    padding: 8,
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={btnStyle}
        title={formatLabel(selectedValues)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {formatLabel(selectedValues)}
      </button>
      {open && (
        <div role="dialog" aria-label="Filter by label" style={menuStyle}>
          <button
            type="button"
            onClick={() => onChange([])}
            style={{
              width: "100%",
              padding: "4px 6px",
              border: "1px solid var(--color-border)",
              borderRadius: 3,
              background:
                selectedValues.length === 0 ? "var(--color-hover-bg)" : "var(--color-surface)",
              cursor: "pointer",
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            Clear (All labels)
          </button>

          {labels.map((label) => (
            <label
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                marginBottom: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selectedSet.has(label)}
                onChange={() => onChange(toggleValue(selectedValues, label))}
              />
              {label}
            </label>
          ))}

          <div
            style={{
              borderTop: "1px solid var(--color-border-light)",
              margin: "6px 0",
              paddingTop: 6,
            }}
          />

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              marginBottom: 6,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={selectedSet.has(NO_LABEL)}
              onChange={() => onChange(toggleValue(selectedValues, NO_LABEL))}
            />
            No label
          </label>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                padding: "3px 10px",
                border: "1px solid var(--color-border)",
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
