import { useCallback, useRef, useState } from "react";
import type { ScaleTime } from "d3-scale";
import { formatDate } from "../lib/date-utils.js";

interface DrawState {
  taskId: string;
  startX: number;
  startDate: Date;
  svgRect: DOMRect;
}

export interface DrawPreview {
  taskId: string;
  x: number;
  width: number;
}

export function useDrawBar(
  xScale: ScaleTime<number, number>,
  onSchedule: (taskId: string, updates: { start_date: string; end_date: string }) => void,
) {
  const drawState = useRef<DrawState | null>(null);
  const [preview, setPreview] = useState<DrawPreview | null>(null);

  const startDraw = useCallback(
    (e: React.MouseEvent, taskId: string, svgElement: SVGSVGElement) => {
      e.preventDefault();
      e.stopPropagation();

      const svgRect = svgElement.getBoundingClientRect();
      const relativeX = e.clientX - svgRect.left;
      const startDate = xScale.invert(relativeX);

      drawState.current = { taskId, startX: relativeX, startDate, svgRect };
      setPreview({ taskId, x: relativeX, width: 0 });

      const onMouseMove = (ev: MouseEvent) => {
        if (!drawState.current) return;
        const currentX = ev.clientX - drawState.current.svgRect.left;
        const minX = Math.min(drawState.current.startX, currentX);
        const w = Math.abs(currentX - drawState.current.startX);
        setPreview({ taskId: drawState.current.taskId, x: minX, width: w });
      };

      const onMouseUp = (ev: MouseEvent) => {
        if (!drawState.current) return;
        const state = drawState.current;
        const currentX = ev.clientX - state.svgRect.left;
        const endDate = xScale.invert(currentX);

        let d1 = new Date(state.startDate);
        let d2 = new Date(endDate);

        // Normalize to date-only (strip time)
        d1 = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate());
        d2 = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate());

        // Swap if needed
        if (d1 > d2) {
          const tmp = d1;
          d1 = d2;
          d2 = tmp;
        }

        // Zero width click → 1-day task
        if (d1.getTime() === d2.getTime()) {
          d2 = new Date(d1);
          d2.setDate(d2.getDate() + 1);
        }

        onSchedule(state.taskId, {
          start_date: formatDate(d1),
          end_date: formatDate(d2),
        });

        drawState.current = null;
        setPreview(null);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [xScale, onSchedule],
  );

  return { startDraw, preview };
}
