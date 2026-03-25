import React from "react";

export const PRIORITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

const PRIORITY_COLORS: Record<PriorityLevel, { bg: string; fg: string; border: string }> = {
  critical: {
    bg: "var(--color-danger-bg)",
    fg: "var(--color-danger-dark)",
    border: "rgba(231, 76, 60, 0.27)",
  },
  high: {
    bg: "var(--color-warning-bg)",
    fg: "var(--color-warning-dark)",
    border: "rgba(243, 156, 18, 0.27)",
  },
  medium: { bg: "var(--color-info-bg)", fg: "#2471a3", border: "rgba(52, 152, 219, 0.27)" },
  low: {
    bg: "var(--color-priority-low-bg)",
    fg: "var(--color-priority-low-fg)",
    border: "var(--color-priority-low-border)",
  },
};

interface PriorityBadgeProps {
  priority: string | undefined;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  if (!priority || typeof priority !== "string") return null;
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
  if (!priority || typeof priority !== "string") return null;
  const level = priority.toLowerCase() as PriorityLevel;
  return PRIORITY_COLORS[level]?.fg ?? null;
}
