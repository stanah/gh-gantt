import React from "react";

interface FilterEmptyStateProps {
  onReset: () => void;
}

export function FilterEmptyState({ onReset }: FilterEmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        minHeight: 240,
        color: "var(--color-text-muted)",
        gap: 12,
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.35-4.35" />
        <path d="M8 11h6" />
      </svg>
      <span style={{ fontSize: 13 }}>条件に一致するタスクがありません</span>
      <button
        type="button"
        onClick={onReset}
        style={{
          marginTop: 4,
          padding: "6px 16px",
          fontSize: 12,
          color: "var(--color-primary)",
          background: "transparent",
          border: "1px solid var(--color-primary)",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        フィルターをリセット
      </button>
    </div>
  );
}

export function NoTasksGuide() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        minHeight: 240,
        color: "var(--color-text-muted)",
        gap: 12,
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M12 8v8" />
        <path d="M8 12h8" />
      </svg>
      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)" }}>
        タスクがまだありません
      </span>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          textAlign: "center",
          maxWidth: 320,
        }}
      >
        <code
          style={{
            fontSize: 11,
            background: "var(--color-border-light)",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          gh-gantt pull
        </code>{" "}
        で GitHub から同期するか、Issue を作成して開始しましょう。
      </div>
    </div>
  );
}
