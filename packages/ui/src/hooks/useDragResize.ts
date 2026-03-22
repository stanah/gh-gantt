import { useCallback, useRef, useState } from "react";
import type { ScaleTime } from "d3-scale";
import { formatDate } from "../lib/date-utils.js";

export type DragMode = "move" | "resize-left" | "resize-right";

export interface DragPreview {
  taskId: string;
  start_date: string;
  end_date: string;
}

export function useDragResize(
  xScale: ScaleTime<number, number>,
  onCommit: (taskId: string, updates: { start_date?: string; end_date?: string }) => void,
) {
  const [preview, setPreview] = useState<DragPreview | null>(null);

  const dragState = useRef<{
    taskId: string;
    mode: DragMode;
    startX: number;
    originalStart: Date;
    originalEnd: Date;
    lastStartDate: string;
    lastEndDate: string;
    changed: boolean;
  } | null>(null);

  const startDrag = useCallback(
    (e: React.MouseEvent, taskId: string, mode: DragMode, startDate: Date, endDate: Date) => {
      e.preventDefault();
      e.stopPropagation();

      const startStr = formatDate(startDate);
      const endStr = formatDate(endDate);

      dragState.current = {
        taskId,
        mode,
        startX: e.clientX,
        originalStart: startDate,
        originalEnd: endDate,
        lastStartDate: startStr,
        lastEndDate: endStr,
        changed: false,
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const dx = ev.clientX - dragState.current.startX;

        const dayWidth = xScale(new Date(2026, 0, 2)) - xScale(new Date(2026, 0, 1));
        const dayDelta = Math.round(dx / dayWidth);

        const state = dragState.current;
        let newStartDate = formatDate(state.originalStart);
        let newEndDate = formatDate(state.originalEnd);

        switch (state.mode) {
          case "move": {
            const newStart = new Date(state.originalStart);
            newStart.setDate(newStart.getDate() + dayDelta);
            const newEnd = new Date(state.originalEnd);
            newEnd.setDate(newEnd.getDate() + dayDelta);
            newStartDate = formatDate(newStart);
            newEndDate = formatDate(newEnd);
            break;
          }
          case "resize-left": {
            const newStart = new Date(state.originalStart);
            newStart.setDate(newStart.getDate() + dayDelta);
            if (newStart < state.originalEnd) {
              newStartDate = formatDate(newStart);
            }
            break;
          }
          case "resize-right": {
            const newEnd = new Date(state.originalEnd);
            newEnd.setDate(newEnd.getDate() + dayDelta);
            if (newEnd > state.originalStart) {
              newEndDate = formatDate(newEnd);
            }
            break;
          }
        }

        if (newStartDate === state.lastStartDate && newEndDate === state.lastEndDate) return;

        state.lastStartDate = newStartDate;
        state.lastEndDate = newEndDate;
        state.changed = dayDelta !== 0;

        setPreview({ taskId: state.taskId, start_date: newStartDate, end_date: newEndDate });
      };

      const onMouseUp = () => {
        const state = dragState.current;
        dragState.current = null;
        setPreview(null);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!state || !state.changed) return;

        const updates: { start_date?: string; end_date?: string } = {};
        const origStart = formatDate(state.originalStart);
        const origEnd = formatDate(state.originalEnd);

        if (state.lastStartDate !== origStart) updates.start_date = state.lastStartDate;
        if (state.lastEndDate !== origEnd) updates.end_date = state.lastEndDate;

        if (Object.keys(updates).length > 0) {
          onCommit(state.taskId, updates);
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [xScale, onCommit],
  );

  return { startDrag, dragPreview: preview };
}
