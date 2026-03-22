import React from "react";

export const PRIORITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

const PRIORITY_COLORS: Record<PriorityLevel, { bg: string; fg: string; border: string }> = {
  critical: { bg: "#fdecea", fg: "#c0392b", border: "#e74c3c44" },
  high: { bg: "#fff4db", fg: "#d35400", border: "#f39c1244" },
  medium: { bg: "#e8f4fd", fg: "#2471a3", border: "#3498db44" },
  low: { bg: "#f0f0f0", fg: "#888", border: "#bbb4" },
};

interface PriorityBadgeProps {
  priority: string | undefined;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  if (!priority) return null;
  const level = priority.toLowerCase() as PriorityLevel;
  const colors = PRIORITY_COLORS[level];
  if (!colors) return null;

  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 5px",
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {level === "critical" ? "CRI" : level === "high" ? "HI" : level === "medium" ? "MED" : "LO"}
    </span>
  );
}

export function getPriorityColor(priority: string | undefined): string | null {
  if (!priority) return null;
  const level = priority.toLowerCase() as PriorityLevel;
  return PRIORITY_COLORS[level]?.fg ?? null;
}
