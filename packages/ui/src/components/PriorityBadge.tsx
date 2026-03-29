import React from "react";

export const PRIORITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

const PRIORITY_CONFIG: Record<PriorityLevel, { bars: number; color: string }> = {
  critical: { bars: 4, color: "#e74c3c" },
  high: { bars: 3, color: "#f39c12" },
  medium: { bars: 2, color: "#3498db" },
  low: { bars: 1, color: "#888" },
};

const BAR_HEIGHTS = [4, 7, 10, 13];
const INACTIVE_COLOR = "rgba(200, 200, 200, 0.4)";

interface PriorityBadgeProps {
  priority: string | undefined;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  if (!priority || typeof priority !== "string") return null;
  const level = priority.toLowerCase() as PriorityLevel;
  const config = PRIORITY_CONFIG[level];
  if (!config) return null;

  const label =
    level === "critical"
      ? "Critical"
      : level === "high"
        ? "High"
        : level === "medium"
          ? "Medium"
          : "Low";

  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        gap: 1,
        height: 14,
        flexShrink: 0,
      }}
    >
      {BAR_HEIGHTS.map((h, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: h,
            borderRadius: 0.5,
            background: i < config.bars ? config.color : INACTIVE_COLOR,
          }}
        />
      ))}
    </span>
  );
}

export function getPriorityColor(priority: string | undefined): string | null {
  if (!priority || typeof priority !== "string") return null;
  const level = priority.toLowerCase() as PriorityLevel;
  return PRIORITY_CONFIG[level]?.color ?? null;
}
