import React, { useState, useCallback, useRef } from "react";

interface LayoutProps {
  leftHeader: React.ReactNode;
  leftBody: React.ReactNode;
  rightHeader: React.ReactNode;
  rightBody: React.ReactNode;
  scrollContainerRef?: React.Ref<HTMLDivElement>;
}

export function Layout({ leftHeader, leftBody, rightHeader, rightBody, scrollContainerRef }: LayoutProps) {
  const [splitPos, setSplitPos] = useState(350);
  const outerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !outerRef.current) return;
      const rect = outerRef.current.getBoundingClientRect();
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
    <div ref={outerRef} style={{ height: "100%", position: "relative" }}>
      {/* Single scroll container for both axes */}
      <div ref={scrollContainerRef} style={{ height: "100%", overflow: "auto" }}>
        <div style={{ display: "flex", width: "fit-content", minWidth: "100%" }}>
          {/* Left column — sticky to left edge */}
          <div style={{
            width: splitPos,
            minWidth: 200,
            flexShrink: 0,
            position: "sticky",
            left: 0,
            zIndex: 3,
            background: "#fff",
            borderRight: "1px solid #e0e0e0",
          }}>
            {/* Left header — sticky to top */}
            <div style={{ position: "sticky", top: 0, zIndex: 4, background: "#fff" }}>
              {leftHeader}
            </div>
            {leftBody}
          </div>

          {/* Right column */}
          <div>
            {/* Right header — sticky to top */}
            <div style={{ position: "sticky", top: 0, zIndex: 2, background: "#fff" }}>
              {rightHeader}
            </div>
            {rightBody}
          </div>
        </div>
      </div>

      {/* Splitter overlay */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: splitPos - 2,
          width: 5,
          cursor: "col-resize",
          zIndex: 20,
        }}
      />
    </div>
  );
}
