import { useState, useMemo, useCallback } from "react";
import { scaleTime } from "d3-scale";
import type { Task } from "../types/index.js";
import { getDateRange } from "../lib/date-utils.js";

export type ViewScale = "day" | "week" | "month" | "quarter";

/** Default pixelsPerDay for each view scale preset */
const PRESET_PPD: Record<ViewScale, number> = {
  day: 40,
  week: 16,
  month: 5,
  quarter: 2,
};

/** Derive viewScale from current pixelsPerDay */
function deriveViewScale(ppd: number): ViewScale {
  if (ppd >= 25) return "day";
  if (ppd >= 8) return "week";
  if (ppd >= 3) return "month";
  return "quarter";
}

const MIN_PPD = 0.5;
const MAX_PPD = 120;

export function useGanttScale(tasks: Task[], initialView: ViewScale = "month", minWidth = 800) {
  const [pixelsPerDay, setPixelsPerDay] = useState(PRESET_PPD[initialView]);

  const viewScale = deriveViewScale(pixelsPerDay);

  const setViewScale = useCallback((scale: ViewScale) => {
    setPixelsPerDay(PRESET_PPD[scale]);
  }, []);

  const baseDateRange = useMemo(() => {
    return getDateRange(tasks);
  }, [tasks]);

  const totalDays = Math.ceil(
    (baseDateRange[1].getTime() - baseDateRange[0].getTime()) / (1000 * 60 * 60 * 24),
  );
  const dataWidth = totalDays * pixelsPerDay;
  const totalWidth = Math.max(dataWidth, minWidth || 800);

  // When viewport is wider than data, extend the date range
  // so the xScale maintains the correct pixelsPerDay ratio
  const dateRange = useMemo<[Date, Date]>(() => {
    if (totalWidth <= dataWidth) return baseDateRange;
    const effectiveDays = totalWidth / pixelsPerDay;
    const end = new Date(baseDateRange[0].getTime() + effectiveDays * 24 * 60 * 60 * 1000);
    return [baseDateRange[0], end];
  }, [baseDateRange, totalWidth, dataWidth, pixelsPerDay]);

  const xScale = useMemo(() => {
    return scaleTime()
      .domain(dateRange)
      .range([0, totalWidth]);
  }, [dateRange, totalWidth]);

  const zoomIn = useCallback(() => {
    setPixelsPerDay((p) => Math.min(p * 1.15, MAX_PPD));
  }, []);

  const zoomOut = useCallback(() => {
    setPixelsPerDay((p) => Math.max(p / 1.15, MIN_PPD));
  }, []);

  return {
    viewScale,
    setViewScale,
    zoomIn,
    zoomOut,
    xScale,
    dateRange,
    totalWidth,
    pixelsPerDay,
  };
}
