import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import { timeDay, timeWeek, timeMonth } from "d3-time";
import type { ViewScale } from "../hooks/useGanttScale.js";

interface SprintHeaderItem {
  name: string;
  start_date: string;
  end_date: string;
  color?: string;
}

interface GanttTimelineProps {
  xScale: ScaleTime<number, number>;
  dateRange: [Date, Date];
  viewScale: ViewScale;
  totalWidth: number;
  sprints?: SprintHeaderItem[];
}

function parseSprintDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

export function GanttTimeline({
  xScale,
  dateRange,
  viewScale,
  totalWidth,
  sprints,
}: GanttTimelineProps) {
  const ticks = useMemo(() => {
    const interval = viewScale === "day" ? timeDay : viewScale === "week" ? timeWeek : timeMonth;
    return interval.range(dateRange[0], dateRange[1]);
  }, [dateRange, viewScale]);

  const sprintBands = useMemo(() => {
    if (!sprints || sprints.length === 0) return [];
    return sprints
      .map((sprint, index) => {
        const start = parseSprintDate(sprint.start_date);
        const end = parseSprintDate(sprint.end_date);
        if (!isValidDate(start) || !isValidDate(end) || end < start) return null;
        return {
          key: `${sprint.name}-${index}`,
          name: sprint.name,
          color: sprint.color ?? "#3b82f6",
          start,
          end,
        };
      })
      .filter(
        (item): item is { key: string; name: string; color: string; start: Date; end: Date } =>
          item != null,
      );
  }, [sprints]);

  const formatTick = (date: Date) => {
    if (viewScale === "day") {
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }
    if (viewScale === "week") {
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    if (viewScale === "month") {
      return `${months[date.getMonth()]} ${date.getFullYear()}`;
    }
    return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
  };

  const sprintRowHeight = sprintBands.length > 0 ? 20 : 0;
  const tickRowHeight = 32;
  const totalHeight = sprintRowHeight + tickRowHeight;
  const tickOffsetY = sprintRowHeight;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div
      style={{
        height: totalHeight,
        borderBottom: "1px solid #e0e0e0",
        position: "relative",
        background: "#fafafa",
      }}
    >
      <svg width={totalWidth} height={totalHeight}>
        {sprintBands.map((sprint) => {
          const bandStart = xScale(sprint.start);
          const inclusiveEnd = new Date(sprint.end);
          inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);
          const bandEnd = xScale(inclusiveEnd);
          const width = Math.max(0, bandEnd - bandStart);
          const isCurrent = sprint.start <= today && today <= sprint.end;
          const labelVisible = width >= 52;
          return (
            <g key={sprint.key}>
              <rect
                x={bandStart}
                y={0}
                width={width}
                height={sprintRowHeight}
                fill={sprint.color}
                fillOpacity={isCurrent ? 0.34 : 0.18}
                stroke={isCurrent ? sprint.color : "#cbd5e1"}
                strokeWidth={isCurrent ? 1.5 : 1}
              />
              {labelVisible && (
                <text
                  x={bandStart + 6}
                  y={13}
                  fontSize={10}
                  fill={isCurrent ? "#0f172a" : "#334155"}
                >
                  {sprint.name}
                </text>
              )}
            </g>
          );
        })}

        {sprintRowHeight > 0 && (
          <line x1={0} y1={sprintRowHeight} x2={totalWidth} y2={sprintRowHeight} stroke="#e2e8f0" />
        )}

        {ticks.map((tick, i) => {
          const x = xScale(tick);
          return (
            <g key={i}>
              <line x1={x} y1={tickOffsetY + 24} x2={x} y2={tickOffsetY + 32} stroke="#ccc" />
              <text x={x + 4} y={tickOffsetY + 18} fontSize={10} fill="#666">
                {formatTick(tick)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
