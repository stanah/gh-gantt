import React, { useState, useRef, useCallback } from "react";
import { useApi } from "./hooks/useApi.js";
import { useTaskTree } from "./hooks/useTaskTree.js";
import { useTypeFilter } from "./hooks/useTypeFilter.js";
import { Layout } from "./components/Layout.js";
import { TaskTree } from "./components/TaskTree.js";
import { GanttChart, type GanttChartHandle } from "./components/GanttChart.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { Toolbar } from "./components/Toolbar.js";
import type { ViewScale } from "./hooks/useGanttScale.js";

export function App() {
  const { config, tasks, cache, loading, error, updateTask, refresh } = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [viewScale, setViewScale] = useState<ViewScale>("month");
  const ganttRef = useRef<GanttChartHandle>(null);

  const handleViewScaleChange = useCallback((scale: ViewScale) => {
    setViewScale(scale);
  }, []);

  const { enabled, toggle: toggleType } = useTypeFilter(config?.task_types ?? {});
  const { flatList, collapsed, toggle: toggleCollapse } = useTaskTree(tasks, enabled);

  const handlePull = useCallback(async () => {
    await fetch("/api/sync/pull", { method: "POST" });
    await refresh();
  }, [refresh]);

  const handlePush = useCallback(async () => {
    await fetch("/api/sync/push", { method: "POST" });
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#888" }}>
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#e74c3c" }}>
        Error: {error}
      </div>
    );
  }

  if (!config) return null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 16px", borderBottom: "1px solid #e0e0e0", background: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
        <strong>{config.project.name}</strong>
        <span style={{ color: "#888", fontSize: 12 }}>{tasks.length} tasks</span>
      </header>
      <Toolbar
        viewScale={viewScale}
        onSetViewScale={(s) => { ganttRef.current?.setViewScale(s); }}
        onZoomIn={() => ganttRef.current?.zoomIn()}
        onZoomOut={() => ganttRef.current?.zoomOut()}
        onScrollToToday={() => ganttRef.current?.scrollToToday()}
        onPull={handlePull}
        onPush={handlePush}
      />
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Layout
          left={
            <TaskTree
              tasks={tasks}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onDoubleClickTask={setDetailTaskId}
              enabledTypes={enabled}
              onToggleType={toggleType}
              flatList={flatList}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
            />
          }
          right={
            <GanttChart
              ref={ganttRef}
              tasks={tasks}
              flatList={flatList}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onUpdateTask={(taskId, updates) => updateTask(taskId, updates)}
              onViewScaleChange={handleViewScaleChange}
            />
          }
        />
      </div>
      {detailTaskId && (() => {
        const detailTask = tasks.find((t) => t.id === detailTaskId);
        if (!detailTask) return null;
        return (
          <TaskDetailPanel
            task={detailTask}
            config={config}
            comments={cache.comments[detailTaskId] ?? []}
            onUpdate={(updates) => updateTask(detailTaskId, updates)}
            onClose={() => setDetailTaskId(null)}
          />
        );
      })()}
    </div>
  );
}
