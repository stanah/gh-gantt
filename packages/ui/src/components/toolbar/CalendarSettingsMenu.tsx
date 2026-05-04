import React, { useEffect, useRef, useState } from "react";
import { CalendarDays, Plus, X } from "lucide-react";
import type { CalendarHoliday } from "../../types/index.js";
import { IconButton } from "./IconButton.js";

interface CalendarSettingsMenuProps {
  configuredHolidays: CalendarHoliday[];
  customDaysOff: CalendarHoliday[];
  onAddCustomDayOff: (day: CalendarHoliday) => void;
  onRemoveCustomDayOff: (date: string) => void;
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 20,
  width: 260,
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

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "var(--color-text-secondary)",
  minHeight: 24,
};

const separator: React.CSSProperties = {
  borderTop: "1px solid var(--color-border-light)",
  margin: "8px 0",
};

function holidayLabel(day: CalendarHoliday): string {
  return day.name ? `${day.date} ${day.name}` : day.date;
}

export function CalendarSettingsMenu({
  configuredHolidays,
  customDaysOff,
  onAddCustomDayOff,
  onRemoveCustomDayOff,
}: CalendarSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
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

  const handleAdd = () => {
    if (!date) return;
    const trimmedName = name.trim();
    onAddCustomDayOff(trimmedName ? { date, name: trimmedName } : { date });
    setDate("");
    setName("");
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <IconButton
        icon={<CalendarDays size={14} />}
        title="Calendar Settings"
        onClick={() => setOpen((prev) => !prev)}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
      />
      {open && (
        <div role="menu" style={panelStyle}>
          <div style={sectionLabel}>Calendar</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
            <input
              aria-label="Custom day off date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={inputStyle}
            />
            <input
              aria-label="Custom day off name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!date}
              style={{
                ...inputStyle,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                cursor: date ? "pointer" : "not-allowed",
                opacity: date ? 1 : 0.5,
              }}
            >
              <Plus size={12} />
              Add
            </button>
          </div>

          <div style={separator} />
          <div style={sectionLabel}>Configured</div>
          {configuredHolidays.length === 0 ? (
            <div style={rowStyle}>None</div>
          ) : (
            configuredHolidays.map((day) => (
              <div key={day.date} style={rowStyle}>
                <span>{holidayLabel(day)}</span>
              </div>
            ))
          )}

          <div style={separator} />
          <div style={sectionLabel}>Custom days off</div>
          {customDaysOff.length === 0 ? (
            <div style={rowStyle}>None</div>
          ) : (
            customDaysOff.map((day) => (
              <div key={day.date} style={rowStyle}>
                <span style={{ flex: 1 }}>{holidayLabel(day)}</span>
                <button
                  type="button"
                  title={`Remove ${day.date}`}
                  onClick={() => onRemoveCustomDayOff(day.date)}
                  style={{
                    width: 22,
                    height: 22,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    borderRadius: 3,
                    background: "transparent",
                    color: "var(--color-text-muted)",
                    cursor: "pointer",
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
