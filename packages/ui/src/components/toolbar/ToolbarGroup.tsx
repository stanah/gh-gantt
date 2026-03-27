import React from "react";

interface ToolbarGroupProps {
  children: React.ReactNode;
  gap?: number;
}

export function ToolbarGroup({ children, gap = 2 }: ToolbarGroupProps) {
  return <div style={{ display: "flex", gap, alignItems: "center" }}>{children}</div>;
}
