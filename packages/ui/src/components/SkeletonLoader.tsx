import React from "react";

const shimmerKeyframes = `
@keyframes gh-gantt-shimmer {
  0% { background-position: -200px 0; }
  100% { background-position: calc(200px + 100%) 0; }
}
@media (prefers-reduced-motion: reduce) {
  .gh-gantt-shimmer-bar { animation: none !important; }
}
`;

let shimmerInjected = false;
function ensureShimmerStyles() {
  if (shimmerInjected) return;
  const style = document.createElement("style");
  style.textContent = shimmerKeyframes;
  document.head.appendChild(style);
  shimmerInjected = true;
}

function SkeletonBar({
  width,
  height = 12,
  style,
}: {
  width: number | string;
  height?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="gh-gantt-shimmer-bar"
      style={{
        width,
        height,
        borderRadius: 4,
        background:
          "linear-gradient(90deg, var(--color-border-light) 25%, var(--color-border) 50%, var(--color-border-light) 75%)",
        backgroundSize: "200px 100%",
        animation: "gh-gantt-shimmer 1.5s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

function SkeletonRow({ index }: { index: number }) {
  const indent = index % 5 === 0 ? 0 : index % 3 === 0 ? 16 : 32;
  const titleWidth = 80 + ((index * 37) % 120);
  return (
    <div
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        gap: 8,
        paddingLeft: 8 + indent,
        paddingRight: 8,
      }}
    >
      <SkeletonBar width={titleWidth} height={10} />
    </div>
  );
}

function SkeletonGanttRow({ index }: { index: number }) {
  const left = 40 + ((index * 53) % 200);
  const barWidth = 60 + ((index * 71) % 180);
  return (
    <div
      style={{
        height: 28,
        position: "relative",
      }}
    >
      <SkeletonBar
        width={barWidth}
        height={14}
        style={{
          position: "absolute",
          left,
          top: 7,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

export function SkeletonLoader() {
  const rowCount = 12;
  const rows = Array.from({ length: rowCount }, (_, i) => i);

  ensureShimmerStyles();

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header skeleton */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <SkeletonBar width={120} height={14} />
        <SkeletonBar width={60} height={10} />
      </div>

      {/* Toolbar skeleton */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <SkeletonBar width={28} height={24} style={{ borderRadius: 4 }} />
        <SkeletonBar width={28} height={24} style={{ borderRadius: 4 }} />
        <SkeletonBar width={28} height={24} style={{ borderRadius: 4 }} />
        <div style={{ width: 16 }} />
        <SkeletonBar width={64} height={24} style={{ borderRadius: 4 }} />
        <SkeletonBar width={64} height={24} style={{ borderRadius: 4 }} />
        <SkeletonBar width={64} height={24} style={{ borderRadius: 4 }} />
      </div>

      {/* Main content skeleton */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
        {/* Left pane - Task tree */}
        <div
          style={{
            width: 350,
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          {/* Tree header */}
          <div
            style={{
              height: 32,
              borderBottom: "1px solid var(--color-border)",
            }}
          />
          {rows.map((i) => (
            <SkeletonRow key={i} index={i} />
          ))}
        </div>

        {/* Right pane - Gantt chart */}
        <div style={{ flex: 1 }}>
          {/* Timeline header */}
          <div
            style={{
              height: 32,
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              gap: 40,
              padding: "0 20px",
            }}
          >
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonBar key={i} width={40} height={10} />
            ))}
          </div>
          {rows.map((i) => (
            <SkeletonGanttRow key={i} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
