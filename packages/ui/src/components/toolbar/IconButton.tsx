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
  border: "1px solid #ddd",
  borderRadius: 3,
  background: "#fff",
  color: "#555",
  cursor: "pointer",
  fontSize: 11,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  lineHeight: 1,
};

const activeStyle: React.CSSProperties = {
  background: "#e8f0fe",
  color: "#1a73e8",
  borderColor: "#c5d7f7",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: "default",
};

const badgeStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "#fff",
  borderRadius: 8,
  padding: "0 5px",
  fontSize: 9,
  minWidth: 16,
  textAlign: "center",
  lineHeight: "16px",
};

export function IconButton({ icon, title, onClick, active = false, disabled = false, badge, children }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      style={{ ...baseStyle, ...(active ? activeStyle : {}), ...(disabled ? disabledStyle : {}) }}
    >
      {icon}
      {children}
      {badge != null && badge > 0 && <span style={badgeStyle}>{badge}</span>}
    </button>
  );
}
