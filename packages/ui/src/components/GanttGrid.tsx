import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import { timeDay } from "d3-time";
import { isWorkingDay, parseDate } from "../lib/date-utils.js";

interface SprintGridItem {
  name: string;
  start_date: string;
  end_date: string;
  color?: string;
}

interface GanttGridProps {
  xScale: ScaleTime<number, number>;
  dateRange: [Date, Date];
  totalWidth: number;
  totalHeight: number;
  workingDays: number[];
  pixelsPerDay: number;
  sprints?: SprintGridItem[];
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

export function GanttGrid({
  xScale,
  dateRange,
  totalWidth,
  totalHeight,
  workingDays,
  pixelsPerDay,
  sprints,
}: GanttGridProps) {
  const days = useMemo(() => timeDay.range(dateRange[0], dateRange[1]), [dateRange]);
  const sprintBands = useMemo(() => {
    if (!sprints || sprints.length === 0) return [];
    const viewStart = dateRange[0].getTime();
    const viewEnd = dateRange[1].getTime();
    return sprints
      .map((sprint, index) => {
        const start = parseDate(sprint.start_date);
        const end = parseDate(sprint.end_date);
        if (!isValidDate(start) || !isValidDate(end) || end < start) return null;
        if (end.getTime() < viewStart || start.getTime() > viewEnd) return null;
        return {
          key: `${sprint.name}-${index}`,
          start,
          end,
          color: sprint.color ?? "#3b82f6",
        };
      })
      .filter(
        (item): item is { key: string; start: Date; end: Date; color: string } => item != null,
      );
  }, [dateRange, sprints]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayX = xScale(today);

  return (
    <svg
      width={totalWidth}
      height={totalHeight}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
    >
      {/* Sprint band highlight */}
      {sprintBands.map((sprint) => {
        const bandStart = xScale(sprint.start);
        const inclusiveEnd = new Date(sprint.end);
        inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);
        const bandEnd = xScale(inclusiveEnd);
        const x = Math.max(0, bandStart);
        const width = Math.max(0, Math.min(totalWidth, bandEnd) - x);
        if (width <= 0) return null;
        const isCurrent = sprint.start <= today && today <= sprint.end;
        return (
          <rect
            key={`sprint-bg-${sprint.key}`}
            x={x}
            y={0}
            width={width}
            height={totalHeight}
            fill={sprint.color}
            fillOpacity={isCurrent ? 0.09 : 0.04}
          />
        );
      })}

      {/* Non-working day shading */}
      {pixelsPerDay >= 4 &&
        days.map((day, i) => {
          if (isWorkingDay(day, workingDays)) return null;
          const x = xScale(day);
          const nextDay = new Date(day);
          nextDay.setDate(nextDay.getDate() + 1);
          const w = xScale(nextDay) - x;
          return (
            <rect
              key={i}
              x={x}
              y={0}
              width={w}
              height={totalHeight}
              fill="var(--color-border-light)"
            />
          );
        })}

      {/* Grid lines for months */}
      {days
        .filter((d) => d.getDate() === 1)
        .map((day, i) => {
          const x = xScale(day);
          return (
            <line
              key={`m${i}`}
              x1={x}
              y1={0}
              x2={x}
              y2={totalHeight}
              stroke="var(--color-border)"
            />
          );
        })}

      {/* Sprint boundaries */}
      {sprintBands.flatMap((sprint) => {
        const startX = xScale(sprint.start);
        const endExclusive = new Date(sprint.end);
        endExclusive.setDate(endExclusive.getDate() + 1);
        const endX = xScale(endExclusive);
        return [
          <line
            key={`sprint-start-${sprint.key}`}
            x1={startX}
            y1={0}
            x2={startX}
            y2={totalHeight}
            stroke={sprint.color}
            strokeOpacity={0.5}
            strokeWidth={1}
          />,
          <line
            key={`sprint-end-${sprint.key}`}
            x1={endX}
            y1={0}
            x2={endX}
            y2={totalHeight}
            stroke={sprint.color}
            strokeOpacity={0.35}
            strokeWidth={1}
            strokeDasharray="3 2"
          />,
        ];
      })}

      {/* Today line */}
      {todayX >= 0 && todayX <= totalWidth && (
        <line
          x1={todayX}
          y1={0}
          x2={todayX}
          y2={totalHeight}
          stroke="var(--color-danger)"
          strokeWidth={2}
          strokeDasharray="4 2"
        />
      )}
    </svg>
  );
}
