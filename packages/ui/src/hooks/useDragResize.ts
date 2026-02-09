import { useCallback, useRef } from "react";
import type { ScaleTime } from "d3-scale";
import { formatDate } from "../lib/date-utils.js";

export type DragMode = "move" | "resize-left" | "resize-right";

interface DragState {
  mode: DragMode;
  startX: number;
  originalStart: Date;
  originalEnd: Date;
}

export function useDragResize(
  xScale: ScaleTime<number, number>,
  onUpdate: (taskId: string, updates: { start_date?: string; end_date?: string }) => void,
) {
  const dragState = useRef<(DragState & { taskId: string }) | null>(null);

  const startDrag = useCallback(
    (e: React.MouseEvent, taskId: string, mode: DragMode, startDate: Date, endDate: Date) => {
      e.preventDefault();
      e.stopPropagation();

      dragState.current = {
        taskId,
        mode,
        startX: e.clientX,
        originalStart: startDate,
        originalEnd: endDate,
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const dx = ev.clientX - dragState.current.startX;

        // Convert pixel delta to day delta
        const dayWidth = xScale(new Date(2026, 0, 2)) - xScale(new Date(2026, 0, 1));
        const dayDelta = Math.round(dx / dayWidth);

        if (dayDelta === 0) return;

        const state = dragState.current;
        const updates: { start_date?: string; end_date?: string } = {};

        switch (state.mode) {
          case "move": {
            const newStart = new Date(state.originalStart);
            newStart.setDate(newStart.getDate() + dayDelta);
            const newEnd = new Date(state.originalEnd);
            newEnd.setDate(newEnd.getDate() + dayDelta);
            updates.start_date = formatDate(newStart);
            updates.end_date = formatDate(newEnd);
            break;
          }
          case "resize-left": {
            const newStart = new Date(state.originalStart);
            newStart.setDate(newStart.getDate() + dayDelta);
            if (newStart < state.originalEnd) {
              updates.start_date = formatDate(newStart);
            }
            break;
          }
          case "resize-right": {
            const newEnd = new Date(state.originalEnd);
            newEnd.setDate(newEnd.getDate() + dayDelta);
            if (newEnd > state.originalStart) {
              updates.end_date = formatDate(newEnd);
            }
            break;
          }
        }

        if (Object.keys(updates).length > 0) {
          onUpdate(state.taskId, updates);
        }
      };

      const onMouseUp = () => {
        dragState.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [xScale, onUpdate],
  );

  return { startDrag };
}
