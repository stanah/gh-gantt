import React, { useState } from "react";
import { useApi } from "./hooks/useApi.js";
import { useTaskTree } from "./hooks/useTaskTree.js";
import { useTypeFilter } from "./hooks/useTypeFilter.js";
import { Layout } from "./components/Layout.js";
import { TaskTree } from "./components/TaskTree.js";
import { GanttChart } from "./components/GanttChart.js";

export function App() {
  const { config, tasks, loading, error } = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  // Lift type filter and tree state so both panes share it
  const { enabled, toggle: toggleType } = useTypeFilter(config?.task_types ?? {});
  const { flatList, collapsed, toggle: toggleCollapse } = useTaskTree(tasks, enabled);

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
              tasks={tasks}
              flatList={flatList}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          }
        />
      </div>
    </div>
  );
}
