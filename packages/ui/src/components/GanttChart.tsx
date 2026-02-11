import React, { useRef, useCallback, useImperativeHandle, forwardRef, useEffect } from "react";
import { GanttTimeline } from "./GanttTimeline.js";
import { GanttGrid } from "./GanttGrid.js";
import { GanttBar } from "./GanttBar.js";
import { GanttSummaryBar } from "./GanttSummaryBar.js";
import { GanttMilestone } from "./GanttMilestone.js";
import { GanttBlockLines } from "./GanttBlockLines.js";
import { useGanttScale, type ViewScale } from "../hooks/useGanttScale.js";
import { useDragResize } from "../hooks/useDragResize.js";
import { useDrawBar } from "../hooks/useDrawBar.js";
import { parseDate } from "../lib/date-utils.js";
import { ROW_HEIGHT } from "./TaskTree.js";
import type { Task, Config } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";

export interface GanttChartHandle {
  viewScale: ViewScale;
  setViewScale: (s: ViewScale) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  scrollToToday: () => void;
}

interface GanttChartProps {
  tasks: Task[];
  flatList: TreeNode[];
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onUpdateTask?: (taskId: string, updates: { start_date?: string; end_date?: string }) => void;
  onViewScaleChange?: (scale: ViewScale) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  header: (node: React.ReactNode) => void;
  backlogFlatList?: TreeNode[];
  backlogCollapsed?: boolean;
  backlogTotalCount?: number;
  displayOptions?: Set<DisplayOption>;
  hoveredTaskId?: string | null;
  onHoverTask?: (taskId: string | null) => void;
}

export const GanttChart = forwardRef<GanttChartHandle, GanttChartProps>(function GanttChart(
  { tasks, flatList, config, selectedTaskId, onSelectTask, onUpdateTask, onViewScaleChange, scrollContainerRef, header, backlogFlatList, backlogCollapsed, backlogTotalCount, displayOptions, hoveredTaskId, onHoverTask },
  ref,
) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const { xScale, dateRange, totalWidth, viewScale, setViewScale, zoomIn, zoomOut, pixelsPerDay } = useGanttScale(
    tasks,
    config.gantt.default_view,
  );

  // Notify parent when viewScale changes (e.g. due to zoom)
  useEffect(() => {
    onViewScaleChange?.(viewScale);
  }, [viewScale, onViewScaleChange]);

  // Publish the timeline header to parent via render callback
  useEffect(() => {
    header(
      <GanttTimeline xScale={xScale} dateRange={dateRange} viewScale={viewScale} totalWidth={totalWidth} />
    );
  }, [header, xScale, dateRange, viewScale, totalWidth]);

  const backlogHeaderH = (backlogTotalCount ?? 0) > 0 ? ROW_HEIGHT : 0;
  const backlogRowsH = !backlogCollapsed ? (backlogFlatList?.length ?? 0) * ROW_HEIGHT : 0;
  const scheduledHeight = flatList.length * ROW_HEIGHT;
  const totalHeight = scheduledHeight + backlogHeaderH + backlogRowsH;

  const handleDragUpdate = useCallback(
    (taskId: string, updates: { start_date?: string; end_date?: string }) => {
      onUpdateTask?.(taskId, updates);
    },
    [onUpdateTask],
  );

  const { startDrag } = useDragResize(xScale, handleDragUpdate);

  const handleSchedule = useCallback(
    (taskId: string, updates: { start_date: string; end_date: string }) => {
      onUpdateTask?.(taskId, updates);
    },
    [onUpdateTask],
  );

  const { startDraw, preview } = useDrawBar(xScale, handleSchedule);
  const backlogSvgRef = useRef<SVGSVGElement>(null);

  // Wheel zoom with passive: false for proper preventDefault
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomIn, zoomOut]);

  // Drag to pan — operates on the shared scroll container
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Middle button or left button with alt
    if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
    e.preventDefault();
    const el = scrollContainerRef?.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startScrollLeft = el.scrollLeft;
    const startScrollTop = el.scrollTop;
    el.style.cursor = "grabbing";

    const onMouseMove = (ev: MouseEvent) => {
      el.scrollLeft = startScrollLeft - (ev.clientX - startX);
      el.scrollTop = startScrollTop - (ev.clientY - startY);
    };
    const onMouseUp = () => {
      el.style.cursor = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [scrollContainerRef]);

  const scrollToToday = useCallback(() => {
    const el = scrollContainerRef?.current;
    if (!el) return;
    const today = new Date();
    const x = xScale(today);
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [xScale, scrollContainerRef]);

  useImperativeHandle(ref, () => ({
    viewScale,
    setViewScale,
    zoomIn,
    zoomOut,
    scrollToToday,
  }), [viewScale, setViewScale, zoomIn, zoomOut, scrollToToday]);

  return (
    <div
      ref={bodyRef}
      onMouseDown={handleMouseDown}
      style={{ width: totalWidth, height: totalHeight, position: "relative" }}
    >
      <GanttGrid
        xScale={xScale}
        dateRange={dateRange}
        totalWidth={totalWidth}
        totalHeight={totalHeight}
        workingDays={config.gantt.working_days}
        pixelsPerDay={pixelsPerDay}
      />
      <GanttBlockLines tasks={tasks} flatList={flatList} xScale={xScale} totalWidth={totalWidth} totalHeight={totalHeight} />
      <svg width={totalWidth} height={scheduledHeight} style={{ position: "absolute", top: 0, left: 0 }}
        onMouseLeave={() => onHoverTask?.(null)}
      >
        {/* Row hover backgrounds */}
        {flatList.map((node, i) => {
          const y = i * ROW_HEIGHT;
          const isHovered = hoveredTaskId === node.task.id;
          const isSelected = selectedTaskId === node.task.id;
          return (
            <rect
              key={`hover-${node.task.id}`}
              x={0}
              y={y}
              width={totalWidth}
              height={ROW_HEIGHT}
              fill={isSelected ? "#e8f0fe" : isHovered ? "#f5f8ff" : "transparent"}
              onMouseEnter={() => onHoverTask?.(node.task.id)}
            />
          );
        })}
        {flatList.map((node, i) => {
          const task = node.task;
          const y = i * ROW_HEIGHT;
          const taskType = config.task_types[task.type];
          const display = taskType?.display ?? "bar";

          const showIssueId = displayOptions?.has("issueId");
          const showAssignees = displayOptions?.has("assignees");

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
                showIssueId={showIssueId}
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
                showIssueId={showIssueId}
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
              showIssueId={showIssueId}
              showAssignees={showAssignees}
            />
          );
        })}
      </svg>
      {backlogHeaderH > 0 && (
        <svg
          ref={backlogSvgRef}
          width={totalWidth}
          height={backlogHeaderH + backlogRowsH}
          style={{ position: "absolute", top: scheduledHeight, left: 0 }}
        >
          {/* Backlog header background */}
          <rect x={0} y={0} width={totalWidth} height={ROW_HEIGHT} fill="#f5f5f5" />
          <line x1={0} y1={0} x2={totalWidth} y2={0} stroke="#e0e0e0" />
          <line x1={0} y1={ROW_HEIGHT} x2={totalWidth} y2={ROW_HEIGHT} stroke="#e0e0e0" />

          {/* Backlog task rows */}
          {!backlogCollapsed && backlogFlatList?.map((node, i) => {
            const y = ROW_HEIGHT + i * ROW_HEIGHT;
            return (
              <rect
                key={node.task.id}
                x={0}
                y={y}
                width={totalWidth}
                height={ROW_HEIGHT}
                fill="transparent"
                style={{ cursor: "crosshair" }}
                onMouseDown={(e) => {
                  if (e.button !== 0 || e.altKey) return;
                  if (backlogSvgRef.current) {
                    startDraw(e, node.task.id, backlogSvgRef.current);
                  }
                }}
              />
            );
          })}

          {/* Draw preview */}
          {preview && (() => {
            const idx = backlogFlatList?.findIndex((n) => n.task.id === preview.taskId) ?? -1;
            if (idx < 0) return null;
            const y = ROW_HEIGHT + idx * ROW_HEIGHT;
            return (
              <rect
                x={preview.x}
                y={y + 4}
                width={Math.max(preview.width, 2)}
                height={ROW_HEIGHT - 8}
                fill="rgba(52, 152, 219, 0.3)"
                stroke="#3498db"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                rx={3}
              />
            );
          })()}
        </svg>
      )}
    </div>
  );
});
