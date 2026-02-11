import React from "react";
import type { StatusValue } from "../types/index.js";

interface StatusBadgeProps {
  status: string | undefined;
  statusValues: Record<string, StatusValue>;
}

export function StatusBadge({ status, statusValues }: StatusBadgeProps) {
  if (!status) return null;
  const sv = statusValues[status];
  const isDone = sv?.done ?? false;
  const color = isDone ? "#8957e5" : "#3fb950";

  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 500,
        background: color + "22",
        color: color,
        border: `1px solid ${color}44`,
      }}
    >
      {status}
    </span>
  );
}
