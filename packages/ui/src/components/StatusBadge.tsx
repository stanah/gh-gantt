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
  const hex = isDone ? "#8957e5" : "#3fb950";

  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 500,
        background: `${hex}22`,
        color: hex,
        border: `1px solid ${hex}44`,
      }}
    >
      {status}
    </span>
  );
}
