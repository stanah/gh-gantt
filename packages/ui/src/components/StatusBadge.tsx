import React from "react";
import type { StatusCategory, StatusValue } from "../types/index.js";

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

/** Backlog: dotted circle */
function BacklogIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <circle
        cx={6}
        cy={6}
        r={4.5}
        fill="none"
        stroke="#8b949e"
        strokeWidth={1.2}
        strokeDasharray="2 2"
      />
    </svg>
  );
}

/** Blocked: octagon stop sign */
function BlockedIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <path d="M4.2 1.2H7.8L10.8 4.2V7.8L7.8 10.8H4.2L1.2 7.8V4.2Z" fill="#e74c3c" />
      <rect x={4} y={5.3} width={4} height={1.4} rx={0.5} fill="white" />
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

const iconByCategory: Record<StatusCategory, () => React.ReactElement> = {
  backlog: () => <BacklogIcon />,
  todo: () => <TodoIcon />,
  in_progress: () => <InProgressIcon />,
  in_review: () => <InReviewIcon />,
  blocked: () => <BlockedIcon />,
  done: () => <DoneIcon />,
};

/** Infer category from status name when category is not explicitly configured. */
function inferCategory(status: string, isDone: boolean): StatusCategory {
  if (isDone) return "done";
  const n = status.toLowerCase().replace(/\s+/g, "_");
  if (n === "in_progress") return "in_progress";
  if (n === "in_review") return "in_review";
  if (n === "backlog") return "backlog";
  if (n === "blocked") return "blocked";
  if (n === "todo") return "todo";
  return "todo"; // fallback
}

function resolveCategory(status: string, sv: StatusValue | undefined): StatusCategory {
  if (sv?.category) return sv.category;
  return inferCategory(status, sv?.done ?? false);
}

export function StatusBadge({ status, statusValues }: StatusBadgeProps) {
  if (!status) return null;
  const sv = statusValues[status];
  const category = resolveCategory(status, sv);

  return (
    <span title={status} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
      {iconByCategory[category]()}
    </span>
  );
}
