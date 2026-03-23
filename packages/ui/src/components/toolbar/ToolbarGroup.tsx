import React from "react";

interface ToolbarGroupProps {
  label?: string;
  children: React.ReactNode;
  gap?: number;
}

export function ToolbarGroup({ label, children, gap = 2 }: ToolbarGroupProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
      {label && (
        <span
          style={{
            fontSize: 9,
            color: "#999",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          {label}
        </span>
      )}
      <div style={{ display: "flex", gap, alignItems: "center" }}>{children}</div>
    </div>
  );
}
