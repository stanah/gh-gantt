import React from "react";
import type { ScaleTime } from "d3-scale";
import type { MilestoneInfo } from "../lib/milestone-utils.js";
import type { Config, Task } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";

export const MILESTONE_LANE_HEIGHT = 22;

interface GanttMilestoneLaneProps {
  milestones: MilestoneInfo[];
  xScale: ScaleTime<number, number>;
  totalWidth: number;
  config: Config;
  onTooltipShow?: (task: Task, e: React.MouseEvent | React.FocusEvent) => void;
  onTooltipHide?: () => void;
  onSelectTask?: (taskId: string) => void;
  selectedTaskId?: string | null;
}

export function GanttMilestoneLane({
  milestones,
  xScale,
  totalWidth,
  config,
  onTooltipShow,
  onTooltipHide,
  onSelectTask,
  selectedTaskId,
}: GanttMilestoneLaneProps) {
  if (milestones.length === 0) return null;

  const size = 6;
  const cy = MILESTONE_LANE_HEIGHT / 2;

  return (
    <div
      data-testid="milestone-lane"
      style={{
        height: MILESTONE_LANE_HEIGHT,
        borderBottom: "1px solid var(--color-border)",
        position: "relative",
        background: "var(--color-bg)",
      }}
    >
      <svg width={totalWidth} height={MILESTONE_LANE_HEIGHT} role="group" aria-label="Milestones">
        {milestones.map(({ task, date }) => {
          const x = xScale(parseDate(date));
          const color = config.task_types[task.type]?.color ?? "#E74C3C";
          const isSelected = selectedTaskId === task.id;
          return (
            <g
              key={task.id}
              role="graphics-symbol"
              aria-label={`Milestone: ${task.title}, ${date}, ${task.state}`}
              tabIndex={0}
              onMouseEnter={(e) => onTooltipShow?.(task, e)}
              onMouseLeave={() => onTooltipHide?.()}
              onFocus={(e) => onTooltipShow?.(task, e)}
              onBlur={() => onTooltipHide?.()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTask?.(task.id);
              }}
              style={{ cursor: onSelectTask ? "pointer" : "default" }}
              className="gantt-focusable"
            >
              <polygon
                points={`${x},${cy - size} ${x + size},${cy} ${x},${cy + size} ${x - size},${cy}`}
                fill={task.state === "closed" ? color : color + "66"}
                stroke={color}
                strokeWidth={isSelected ? 2 : 1}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
