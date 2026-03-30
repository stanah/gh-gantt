import React, { useMemo } from "react";
import type { ScaleTime } from "d3-scale";
import { timeDay, timeMonth } from "d3-time";
import type { ViewScale } from "@gh-gantt/shared";

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

const MONTHS_SHORT = [
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
const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseSprintDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function formatGroupLabel(date: Date, scale: ViewScale): string {
  switch (scale) {
    case "week":
    case "month":
      return `${MONTHS_FULL[date.getMonth()]} ${date.getFullYear()}`;
    case "quarter":
      return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
    case "year":
      return `${date.getFullYear()}`;
    default: {
      const _exhaustive: never = scale;
      return _exhaustive;
    }
  }
}

function formatTickLabel(date: Date, scale: ViewScale): string {
  switch (scale) {
    case "week":
    case "month":
      return `${date.getDate()}`;
    case "quarter":
      return MONTHS_SHORT[date.getMonth()];
    case "year":
      return `Q${Math.floor(date.getMonth() / 3) + 1}`;
    default: {
      const _exhaustive: never = scale;
      return _exhaustive;
    }
  }
}

function getGroupBoundaries(dateRange: [Date, Date], scale: ViewScale): Date[] {
  switch (scale) {
    case "week":
    case "month": {
      const monthStart = new Date(dateRange[0].getFullYear(), dateRange[0].getMonth(), 1);
      return timeMonth.range(monthStart, dateRange[1]);
    }
    case "quarter": {
      const start = new Date(
        dateRange[0].getFullYear(),
        Math.floor(dateRange[0].getMonth() / 3) * 3,
        1,
      );
      const boundaries: Date[] = [];
      const d = new Date(start);
      while (d < dateRange[1]) {
        boundaries.push(new Date(d));
        d.setMonth(d.getMonth() + 3);
      }
      return boundaries;
    }
    case "year": {
      const boundaries: Date[] = [];
      const d = new Date(dateRange[0].getFullYear(), 0, 1);
      while (d < dateRange[1]) {
        boundaries.push(new Date(d));
        d.setFullYear(d.getFullYear() + 1);
      }
      return boundaries;
    }
    default: {
      const _exhaustive: never = scale;
      return _exhaustive;
    }
  }
}

function getTickDates(dateRange: [Date, Date], scale: ViewScale): Date[] {
  switch (scale) {
    case "week":
    case "month":
      return timeDay.range(dateRange[0], dateRange[1]);
    case "quarter":
      return timeMonth.range(dateRange[0], dateRange[1]);
    case "year": {
      const start = new Date(
        dateRange[0].getFullYear(),
        Math.floor(dateRange[0].getMonth() / 3) * 3,
        1,
      );
      const ticks: Date[] = [];
      const d = new Date(start);
      while (d < dateRange[1]) {
        ticks.push(new Date(d));
        d.setMonth(d.getMonth() + 3);
      }
      return ticks;
    }
    default: {
      const _exhaustive: never = scale;
      return _exhaustive;
    }
  }
}

export function GanttTimeline({
  xScale,
  dateRange,
  viewScale,
  totalWidth,
  sprints,
}: GanttTimelineProps) {
  const groupBoundaries = useMemo(
    () => getGroupBoundaries(dateRange, viewScale),
    [dateRange, viewScale],
  );

  const ticks = useMemo(() => getTickDates(dateRange, viewScale), [dateRange, viewScale]);

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

  const sprintRowHeight = sprintBands.length > 0 ? 20 : 0;
  const groupRowHeight = 20;
  const tickRowHeight = 20;
  const totalHeight = sprintRowHeight + groupRowHeight + tickRowHeight;
  const groupOffsetY = sprintRowHeight;
  const tickOffsetY = sprintRowHeight + groupRowHeight;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div
      style={{
        height: totalHeight,
        borderBottom: "1px solid var(--color-border)",
        position: "relative",
        background: "var(--color-bg)",
      }}
    >
      <svg width={totalWidth} height={totalHeight}>
        <style>{`.gantt-focusable:focus { outline: none; } .gantt-focusable:focus-visible { outline: 2px solid var(--color-focus, #4A90D9); outline-offset: 2px; }`}</style>
        {/* Sprint bands */}
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
                stroke={isCurrent ? sprint.color : "var(--color-border)"}
                strokeWidth={isCurrent ? 1.5 : 1}
              />
              {labelVisible && (
                <text
                  x={bandStart + 6}
                  y={13}
                  fontSize={10}
                  fill={isCurrent ? "var(--color-text)" : "var(--color-text-secondary)"}
                >
                  {sprint.name}
                </text>
              )}
            </g>
          );
        })}

        {sprintRowHeight > 0 && (
          <line
            x1={0}
            y1={sprintRowHeight}
            x2={totalWidth}
            y2={sprintRowHeight}
            stroke="var(--color-border)"
          />
        )}

        {/* Upper row: group labels */}
        {groupBoundaries.map((groupStart, i) => {
          const nextGroup = groupBoundaries[i + 1] ?? dateRange[1];
          const x1 = xScale(groupStart);
          const x2 = xScale(nextGroup);
          const width = x2 - x1;
          const label = formatGroupLabel(groupStart, viewScale);
          return (
            <g key={`group-${i}`}>
              <line
                x1={x1}
                y1={groupOffsetY}
                x2={x1}
                y2={groupOffsetY + groupRowHeight}
                stroke="var(--color-border)"
              />
              {width > 40 && (
                <text
                  x={x1 + 6}
                  y={groupOffsetY + 14}
                  fontSize={11}
                  fontWeight={500}
                  fill="var(--color-text-secondary)"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* Divider */}
        <line
          x1={0}
          y1={tickOffsetY}
          x2={totalWidth}
          y2={tickOffsetY}
          stroke="var(--color-border)"
        />

        {/* Lower row: tick labels */}
        {ticks.map((tick, i) => {
          const x = xScale(tick);
          const nextTick = ticks[i + 1];
          const isToday =
            viewScale === "week" || viewScale === "month"
              ? tick.getFullYear() === today.getFullYear() &&
                tick.getMonth() === today.getMonth() &&
                tick.getDate() === today.getDate()
              : nextTick
                ? tick <= today && today < nextTick
                : tick <= today;
          return (
            <g key={`tick-${i}`}>
              <line
                x1={x}
                y1={tickOffsetY}
                x2={x}
                y2={tickOffsetY + 4}
                stroke="var(--color-border)"
              />
              <text
                x={x + 4}
                y={tickOffsetY + 15}
                fontSize={10}
                fill={isToday ? "var(--color-danger)" : "var(--color-text-secondary)"}
                fontWeight={isToday ? 700 : 400}
              >
                {formatTickLabel(tick, viewScale)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
