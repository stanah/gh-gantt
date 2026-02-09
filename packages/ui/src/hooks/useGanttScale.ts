import { useState, useMemo, useCallback } from "react";
import { scaleTime } from "d3-scale";
import type { Task } from "../types/index.js";
import { getDateRange } from "../lib/date-utils.js";

export type ViewScale = "day" | "week" | "month" | "quarter";

const PIXELS_PER_DAY: Record<ViewScale, number> = {
  day: 40,
  week: 16,
  month: 5,
  quarter: 2,
};

export function useGanttScale(tasks: Task[], initialView: ViewScale = "month") {
  const [viewScale, setViewScale] = useState<ViewScale>(initialView);
  const [zoomLevel, setZoomLevel] = useState(1);

  const [dateRange] = useMemo(() => {
    const range = getDateRange(tasks);
    return [range];
  }, [tasks]);

  const pixelsPerDay = PIXELS_PER_DAY[viewScale] * zoomLevel;

  const totalDays = Math.ceil(
    (dateRange[1].getTime() - dateRange[0].getTime()) / (1000 * 60 * 60 * 24),
  );
  const totalWidth = Math.max(totalDays * pixelsPerDay, 800);

  const xScale = useMemo(() => {
    return scaleTime()
      .domain(dateRange)
      .range([0, totalWidth]);
  }, [dateRange, totalWidth]);

  const zoomIn = useCallback(() => setZoomLevel((z) => Math.min(z * 1.3, 10)), []);
  const zoomOut = useCallback(() => setZoomLevel((z) => Math.max(z / 1.3, 0.2)), []);

  return {
    viewScale,
    setViewScale,
    zoomLevel,
    zoomIn,
    zoomOut,
    xScale,
    dateRange,
    totalWidth,
    pixelsPerDay,
  };
}
