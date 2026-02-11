import React from "react";

interface ProgressBarProps {
  progress: number;
  color?: string;
}

export function ProgressBar({ progress, color }: ProgressBarProps) {
  const fillColor = progress === 100 ? "#8957e5" : (color ?? "#3fb950");
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
          background: fillColor,
          borderRadius: 3,
          transition: "width 0.2s",
        }}
      />
    </div>
  );
}
