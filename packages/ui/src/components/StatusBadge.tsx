import React from "react";
import type { StatusValue } from "../types/index.js";

interface StatusBadgeProps {
  status: string | undefined;
  statusValues: Record<string, StatusValue>;
}

/** Todo: empty circle */
function TodoIcon() {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        border: "1.5px solid #aaa",
        display: "inline-block",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    />
  );
}

/** In Progress: play triangle */
function InProgressIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <path d="M3 2.5L9.5 6L3 9.5Z" fill="#3fb950" />
    </svg>
  );
}

/** In Review: eye */
function InReviewIcon() {
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" style={{ flexShrink: 0 }}>
      <path
        d="M7 3C4 3 1.5 6 1.5 6S4 9 7 9S12.5 6 12.5 6S10 3 7 3Z"
        fill="none"
        stroke="#f97316"
        strokeWidth={1.2}
      />
      <circle cx={7} cy={6} r={1.5} fill="#f97316" />
    </svg>
  );
}

/** Done: filled circle with checkmark */
function DoneIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <circle cx={6} cy={6} r={5} fill="#8957e5" />
      <path
        d="M3.5 6L5.2 7.7L8.5 4.3"
        fill="none"
        stroke="white"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getStatusIcon(status: string, isDone: boolean): React.ReactElement {
  const normalized = status.toLowerCase().replace(/\s+/g, "_");

  if (isDone) return <DoneIcon />;
  if (normalized === "in_progress") return <InProgressIcon />;
  if (normalized === "in_review") return <InReviewIcon />;
  if (normalized === "todo") return <TodoIcon />;

  // Fallback: empty circle for unknown statuses
  return <TodoIcon />;
}

export function StatusBadge({ status, statusValues }: StatusBadgeProps) {
  if (!status) return null;
  const sv = statusValues[status];
  const isDone = sv?.done ?? false;

  return (
    <span title={status} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
      {getStatusIcon(status, isDone)}
    </span>
  );
}
