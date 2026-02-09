import React from "react";

interface ProgressBarProps {
  progress: number;
  color?: string;
}

export function ProgressBar({ progress, color = "#2ECC71" }: ProgressBarProps) {
  return (
    <div
      style={{
        width: 60,
        height: 6,
        background: "#e0e0e0",
        borderRadius: 3,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, progress))}%`,
          height: "100%",
          background: progress === 100 ? color : "#3498DB",
          borderRadius: 3,
          transition: "width 0.2s",
        }}
      />
    </div>
  );
}
