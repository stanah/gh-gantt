import React, {
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useEffect,
  useLayoutEffect,
} from "react";
import { GanttTimeline } from "./GanttTimeline.js";
import { GanttGrid } from "./GanttGrid.js";
import { GanttBar } from "./GanttBar.js";
import { GanttSummaryBar } from "./GanttSummaryBar.js";
import { GanttMilestone } from "./GanttMilestone.js";
import { GanttBlockLines } from "./GanttBlockLines.js";
import { GanttTooltip } from "./GanttTooltip.js";
import { useGanttScale } from "../hooks/useGanttScale.js";
import type { ViewScale } from "@gh-gantt/shared";
import { useDragResize } from "../hooks/useDragResize.js";
import { useGanttTooltip } from "../hooks/useGanttTooltip.js";
import { parseDate } from "../lib/date-utils.js";
import { ROW_HEIGHT } from "./TaskTree.js";
import type { Task, Config } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

export interface GanttChartHandle {
  viewScale: ViewScale;
  setViewScale: (s: ViewScale) => void;
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
  displayOptions?: Set<DisplayOption>;
  hoveredTaskId?: string | null;
  onHoverTask?: (taskId: string | null) => void;
  highlightRelationMap?: Map<string, RelationType>;
}

export const GanttChart = forwardRef<GanttChartHandle, GanttChartProps>(function GanttChart(
  {
    tasks,
    flatList,
    config,
    selectedTaskId,
    onSelectTask,
    onUpdateTask,
    onViewScaleChange,
    scrollContainerRef,
    header,
    displayOptions,
    hoveredTaskId,
    onHoverTask,
    highlightRelationMap,
  },
  ref,
) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const parent = bodyRef.current?.parentElement;
    if (!parent) return;
    setContainerWidth(parent.clientWidth);
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const { xScale, dateRange, totalWidth, viewScale, setViewScale, zoomIn, zoomOut, pixelsPerDay } =
    useGanttScale(tasks, config.gantt.default_view, containerWidth);

  // Notify parent when viewScale changes (e.g. due to zoom)
  useEffect(() => {
    onViewScaleChange?.(viewScale);
  }, [viewScale, onViewScaleChange]);

  // Publish the timeline header to parent via render callback
  useEffect(() => {
    header(
      <GanttTimeline
        xScale={xScale}
        dateRange={dateRange}
        viewScale={viewScale}
        totalWidth={totalWidth}
        sprints={config.sprints}
      />,
    );
  }, [config.sprints, header, xScale, dateRange, viewScale, totalWidth]);

  const totalHeight = flatList.length * ROW_HEIGHT;

  const handleDragCommit = useCallback(
    (taskId: string, updates: { start_date?: string; end_date?: string }) => {
      onUpdateTask?.(taskId, updates);
    },
    [onUpdateTask],
  );

  const { startDrag, dragPreview } = useDragResize(xScale, handleDragCommit);

  const { tooltip, show: showTooltip, hide: hideTooltip } = useGanttTooltip(bodyRef);
  const [tooltipSummaryDates, setTooltipSummaryDates] = useState<{
    start: string;
    end: string;
  } | null>(null);

  const handleSummaryTooltipShow = useCallback(
    (
      task: Task,
      dates: { start: string; end: string } | null,
      e: React.MouseEvent | React.FocusEvent,
    ) => {
      setTooltipSummaryDates(dates);
      showTooltip(task, e);
    },
    [showTooltip],
  );

  const handleSummaryTooltipHide = useCallback(() => {
    setTooltipSummaryDates(null);
    hideTooltip();
  }, [hideTooltip]);

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
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
    },
    [scrollContainerRef],
  );

  const scrollToToday = useCallback(() => {
    const el = scrollContainerRef?.current;
    if (!el) return;
    const today = new Date();
    const x = xScale(today);
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [xScale, scrollContainerRef]);

  useImperativeHandle(
    ref,
    () => ({
      viewScale,
      setViewScale,
      scrollToToday,
    }),
    [viewScale, setViewScale, scrollToToday],
  );

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
        sprints={config.sprints}
      />
      <GanttBlockLines
        tasks={tasks}
        flatList={flatList}
        xScale={xScale}
        totalWidth={totalWidth}
        totalHeight={totalHeight}
        hoveredTaskId={hoveredTaskId ?? null}
      />
      <svg
        role="group"
        aria-label={`Gantt chart with ${flatList.length} tasks`}
        width={totalWidth}
        height={totalHeight}
        style={{ position: "absolute", top: 0, left: 0 }}
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
              fill={
                isSelected
                  ? "rgba(66, 133, 244, 0.12)"
                  : isHovered
                    ? "rgba(66, 133, 244, 0.06)"
                    : "transparent"
              }
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTask(node.task.id);
              }}
              onMouseEnter={() => onHoverTask?.(node.task.id)}
            />
          );
        })}
        {flatList.map((node, i) => {
          const rawTask = node.task;
          // Apply drag preview to override dates during drag
          const task =
            dragPreview?.taskId === rawTask.id
              ? { ...rawTask, start_date: dragPreview.start_date, end_date: dragPreview.end_date }
              : rawTask;
          const y = i * ROW_HEIGHT;
          const taskType = config.task_types[task.type];
          const display = taskType?.display ?? "bar";

          const showIssueId = displayOptions?.has("issueId");
          const showAssignees = displayOptions?.has("assignees");

          const isHoveredTask = hoveredTaskId === task.id;
          const highlightType = highlightRelationMap?.get(task.id) ?? null;
          const isDimmed = hoveredTaskId != null && !isHoveredTask && !highlightType;

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
                isDimmed={isDimmed}
                highlightType={highlightType}
                onTooltipShow={handleSummaryTooltipShow}
                onTooltipHide={handleSummaryTooltipHide}
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
                isDimmed={isDimmed}
                highlightType={highlightType}
                onTooltipShow={showTooltip}
                onTooltipHide={hideTooltip}
              />
            );
          }

          const priorityFieldName = config.sync?.field_mapping?.priority;

          return (
            <GanttBar
              key={task.id}
              task={task}
              taskType={taskType}
              xScale={xScale}
              y={y}
              height={ROW_HEIGHT}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTask(task.id);
              }}
              isSelected={selectedTaskId === task.id}
              onDragStart={
                task.start_date && task.end_date
                  ? (e, mode) =>
                      startDrag(
                        e,
                        task.id,
                        mode,
                        parseDate(task.start_date!),
                        parseDate(task.end_date!),
                      )
                  : undefined
              }
              showIssueId={showIssueId}
              showAssignees={showAssignees}
              priorityFieldName={priorityFieldName}
              isDimmed={isDimmed}
              highlightType={highlightType}
              onTooltipShow={showTooltip}
              onTooltipHide={hideTooltip}
            />
          );
        })}
      </svg>
      {tooltip && (
        <GanttTooltip
          task={tooltip.task}
          taskType={config.task_types[tooltip.task.type]}
          x={tooltip.x}
          y={tooltip.y}
          summaryDates={tooltipSummaryDates}
        />
      )}
    </div>
  );
});
