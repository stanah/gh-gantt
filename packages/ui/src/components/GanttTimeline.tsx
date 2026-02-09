import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import { timeDay, timeWeek, timeMonth } from "d3-time";
import type { ViewScale } from "../hooks/useGanttScale.js";

interface GanttTimelineProps {
  xScale: ScaleTime<number, number>;
  dateRange: [Date, Date];
  viewScale: ViewScale;
  totalWidth: number;
}

export function GanttTimeline({ xScale, dateRange, viewScale, totalWidth }: GanttTimelineProps) {
  const ticks = useMemo(() => {
    const interval = viewScale === "day" ? timeDay : viewScale === "week" ? timeWeek : timeMonth;
    return interval.range(dateRange[0], dateRange[1]);
  }, [dateRange, viewScale]);

  const formatTick = (date: Date) => {
    if (viewScale === "day") {
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }
    if (viewScale === "week") {
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (viewScale === "month") {
      return `${months[date.getMonth()]} ${date.getFullYear()}`;
    }
    return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
  };

  return (
    <div style={{ height: 32, borderBottom: "1px solid #e0e0e0", position: "relative", background: "#fafafa" }}>
      <svg width={totalWidth} height={32}>
        {ticks.map((tick, i) => {
          const x = xScale(tick);
          return (
            <g key={i}>
              <line x1={x} y1={24} x2={x} y2={32} stroke="#ccc" />
              <text x={x + 4} y={18} fontSize={10} fill="#666">
                {formatTick(tick)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
