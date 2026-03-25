import React from "react";

interface IconButtonProps {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  children?: React.ReactNode;
}

const baseStyle: React.CSSProperties = {
  padding: "4px 6px",
  border: "1px solid var(--color-border)",
  borderRadius: 3,
  background: "var(--color-surface)",
  color: "var(--color-text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  lineHeight: 1,
  minHeight: 24,
  boxSizing: "border-box",
};

const activeStyle: React.CSSProperties = {
  background: "var(--color-selected-bg)",
  color: "var(--color-selected-fg)",
  borderColor: "var(--color-selected-border)",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: "default",
};

const badgeStyle: React.CSSProperties = {
  background: "var(--color-selected-fg)",
  color: "#fff",
  borderRadius: 8,
  padding: "0 5px",
  fontSize: 9,
  minWidth: 16,
  textAlign: "center",
  lineHeight: "16px",
};

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled = false,
  badge,
  children,
}: IconButtonProps) {
  const isActive = !!active;

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      style={{ ...baseStyle, ...(isActive ? activeStyle : {}), ...(disabled ? disabledStyle : {}) }}
    >
      {icon}
      {children}
      {badge != null && badge > 0 && <span style={badgeStyle}>{badge}</span>}
    </button>
  );
}
