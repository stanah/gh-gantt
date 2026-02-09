import React, { useState, useCallback, useRef } from "react";

interface LayoutProps {
  left: React.ReactNode;
  right: React.ReactNode;
}

export function Layout({ left, right }: LayoutProps) {
  const [splitPos, setSplitPos] = useState(350);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newPos = Math.max(200, Math.min(ev.clientX - rect.left, rect.width - 200));
      setSplitPos(newPos);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={containerRef} style={{ display: "flex", height: "100%", width: "100%" }}>
      <div style={{ width: splitPos, minWidth: 200, overflow: "auto", borderRight: "1px solid #e0e0e0" }}>
        {left}
      </div>
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 5,
          cursor: "col-resize",
          background: "#e0e0e0",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, overflow: "auto" }}>
        {right}
      </div>
    </div>
  );
}
