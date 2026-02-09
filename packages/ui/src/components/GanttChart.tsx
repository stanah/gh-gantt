import React, { useRef, useCallback } from "react";
import { GanttTimeline } from "./GanttTimeline.js";
import { GanttGrid } from "./GanttGrid.js";
import { GanttBar } from "./GanttBar.js";
import { GanttSummaryBar } from "./GanttSummaryBar.js";
import { GanttMilestone } from "./GanttMilestone.js";
import { GanttBlockLines } from "./GanttBlockLines.js";
import { useGanttScale } from "../hooks/useGanttScale.js";
import { useDragResize } from "../hooks/useDragResize.js";
import { parseDate } from "../lib/date-utils.js";
import { ROW_HEIGHT } from "./TaskTree.js";
import type { Task, Config } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

interface GanttChartProps {
  tasks: Task[];
  flatList: TreeNode[];
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onUpdateTask?: (taskId: string, updates: { start_date?: string; end_date?: string }) => void;
}

export function GanttChart({ tasks, flatList, config, selectedTaskId, onSelectTask, onUpdateTask }: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { xScale, dateRange, totalWidth, viewScale, setViewScale, zoomIn, zoomOut, pixelsPerDay } = useGanttScale(
    tasks,
    config.gantt.default_view,
  );

  const totalHeight = flatList.length * ROW_HEIGHT;

  const handleDragUpdate = useCallback(
    (taskId: string, updates: { start_date?: string; end_date?: string }) => {
      onUpdateTask?.(taskId, updates);
    },
    [onUpdateTask],
  );

  const { startDrag } = useDragResize(xScale, handleDragUpdate);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    },
    [zoomIn, zoomOut],
  );

  const scrollToToday = useCallback(() => {
    if (!containerRef.current) return;
    const today = new Date();
    const x = xScale(today);
    containerRef.current.scrollLeft = Math.max(0, x - containerRef.current.clientWidth / 2);
  }, [xScale]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Mini toolbar */}
      <div style={{ padding: "4px 8px", borderBottom: "1px solid #e0e0e0", display: "flex", gap: 4, alignItems: "center", fontSize: 11 }}>
        {(["day", "week", "month", "quarter"] as const).map((scale) => (
          <button
            key={scale}
            onClick={() => setViewScale(scale)}
            style={{
              padding: "2px 8px",
              border: "1px solid #ccc",
              borderRadius: 3,
              background: viewScale === scale ? "#333" : "#fff",
              color: viewScale === scale ? "#fff" : "#333",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {scale}
          </button>
        ))}
        <button onClick={zoomIn} style={{ padding: "2px 6px", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>+</button>
        <button onClick={zoomOut} style={{ padding: "2px 6px", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>-</button>
        <button onClick={scrollToToday} style={{ padding: "2px 8px", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>Today</button>
      </div>

      {/* Timeline header */}
      <div style={{ overflow: "hidden" }}>
        <GanttTimeline xScale={xScale} dateRange={dateRange} viewScale={viewScale} totalWidth={totalWidth} />
      </div>

      {/* Chart body */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        <div style={{ width: totalWidth, height: totalHeight, position: "relative" }}>
          <GanttGrid
            xScale={xScale}
            dateRange={dateRange}
            totalWidth={totalWidth}
            totalHeight={totalHeight}
            workingDays={config.gantt.working_days}
            pixelsPerDay={pixelsPerDay}
          />
          <GanttBlockLines tasks={tasks} flatList={flatList} xScale={xScale} totalWidth={totalWidth} totalHeight={totalHeight} />
          <svg width={totalWidth} height={totalHeight} style={{ position: "absolute", top: 0, left: 0 }}>
            {flatList.map((node, i) => {
              const task = node.task;
              const y = i * ROW_HEIGHT;
              const taskType = config.task_types[task.type];
              const display = taskType?.display ?? "bar";

              if (display === "summary") {
                return (
                  <GanttSummaryBar
                    key={task.id}
                    task={task}
                    allTasks={tasks}
                    taskType={taskType}
                    xScale={xScale}
                    y={y}
                    height={ROW_HEIGHT}
                  />
                );
              }

              if (display === "milestone") {
                return (
                  <GanttMilestone
                    key={task.id}
                    task={task}
                    taskType={taskType}
                    xScale={xScale}
                    y={y}
                    height={ROW_HEIGHT}
                  />
                );
              }

              return (
                <GanttBar
                  key={task.id}
                  task={task}
                  taskType={taskType}
                  xScale={xScale}
                  y={y}
                  height={ROW_HEIGHT}
                  onClick={() => onSelectTask(task.id)}
                  isSelected={selectedTaskId === task.id}
                  onDragStart={task.start_date && task.end_date ? (e, mode) => startDrag(e, task.id, mode, parseDate(task.start_date!), parseDate(task.end_date!)) : undefined}
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
