import React, { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { GanttExportFormat, GanttExportScope } from "@gh-gantt/shared";
import { IconButton } from "./IconButton.js";

export interface ExportRequest {
  format: GanttExportFormat;
  scope: GanttExportScope;
  scaleFactor: 1 | 2;
}

interface ExportMenuProps {
  onExport: (request: ExportRequest) => void;
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 20,
  width: 220,
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

const inputStyle: React.CSSProperties = {
  minHeight: 24,
  border: "1px solid var(--color-border)",
  borderRadius: 3,
  background: "var(--color-bg)",
  color: "var(--color-text)",
  fontSize: 11,
  padding: "3px 6px",
};

export function ExportMenu({ onExport }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<GanttExportFormat>("svg");
  const [scope, setScope] = useState<GanttExportScope>("current");
  const [highResolution, setHighResolution] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleExport = () => {
    onExport({ format, scope, scaleFactor: highResolution ? 2 : 1 });
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <IconButton
        icon={<Download size={14} />}
        title="Export"
        onClick={() => setOpen((prev) => !prev)}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
      />
      {open && (
        <div role="menu" style={panelStyle}>
          <div style={sectionLabel}>Export</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
            <select
              aria-label="Export format"
              value={format}
              onChange={(e) => setFormat(e.target.value as GanttExportFormat)}
              style={inputStyle}
            >
              <option value="svg">SVG</option>
              <option value="png">PNG</option>
            </select>
            <select
              aria-label="Export scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as GanttExportScope)}
              style={inputStyle}
            >
              <option value="current">Current view</option>
              <option value="project">Project</option>
            </select>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--color-text-secondary)",
                fontSize: 11,
              }}
            >
              <input
                type="checkbox"
                aria-label="High resolution 2x"
                checked={highResolution}
                onChange={(e) => setHighResolution(e.target.checked)}
              />
              2x
            </label>
            <button
              type="button"
              aria-label="Run export"
              onClick={handleExport}
              style={{
                ...inputStyle,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                cursor: "pointer",
              }}
            >
              <Download size={12} />
              Export
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
