import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import { timeDay } from "d3-time";
import { isWorkingDay } from "../lib/date-utils.js";

interface GanttGridProps {
  xScale: ScaleTime<number, number>;
  dateRange: [Date, Date];
  totalWidth: number;
  totalHeight: number;
  workingDays: number[];
  pixelsPerDay: number;
}

export function GanttGrid({ xScale, dateRange, totalWidth, totalHeight, workingDays, pixelsPerDay }: GanttGridProps) {
  const days = useMemo(() => timeDay.range(dateRange[0], dateRange[1]), [dateRange]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayX = xScale(today);

  return (
    <svg
      width={totalWidth}
      height={totalHeight}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
    >
      {/* Non-working day shading */}
      {pixelsPerDay >= 4 && days.map((day, i) => {
        if (isWorkingDay(day, workingDays)) return null;
        const x = xScale(day);
        const nextDay = new Date(day);
        nextDay.setDate(nextDay.getDate() + 1);
        const w = xScale(nextDay) - x;
        return (
          <rect key={i} x={x} y={0} width={w} height={totalHeight} fill="#f5f5f5" />
        );
      })}

      {/* Grid lines for months */}
      {days.filter((d) => d.getDate() === 1).map((day, i) => {
        const x = xScale(day);
        return <line key={`m${i}`} x1={x} y1={0} x2={x} y2={totalHeight} stroke="#e0e0e0" />;
      })}

      {/* Today line */}
      {todayX >= 0 && todayX <= totalWidth && (
        <line x1={todayX} y1={0} x2={todayX} y2={totalHeight} stroke="#E74C3C" strokeWidth={2} strokeDasharray="4 2" />
      )}
    </svg>
  );
}
