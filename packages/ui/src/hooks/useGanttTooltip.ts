import { useState, useCallback, useRef, useEffect } from "react";
import type React from "react";
import type { Task } from "../types/index.js";

export interface TooltipState {
  task: Task;
  x: number;
  y: number;
}

export function useGanttTooltip(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const show = useCallback(
    (task: Task, e: React.MouseEvent | React.FocusEvent) => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // For mouse events use clientX/Y, for focus events use target bounding rect
      if ("clientX" in e) {
        setTooltip({ task, x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else {
        const target = e.currentTarget as Element;
        const targetRect = target.getBoundingClientRect();
        setTooltip({
          task,
          x: targetRect.left + targetRect.width / 2 - rect.left,
          y: targetRect.top - rect.top,
        });
      }
    },
    [containerRef],
  );

  const hide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setTooltip(null);
      hideTimerRef.current = null;
    }, 80);
  }, []);

  return { tooltip, show, hide } as const;
}
