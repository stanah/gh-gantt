import React, { useState, useRef, useCallback, useEffect } from "react";
import { useApi } from "./hooks/useApi.js";
import { useTaskTree } from "./hooks/useTaskTree.js";
import { useTypeFilter } from "./hooks/useTypeFilter.js";
import { useDisplayOptions } from "./hooks/useDisplayOptions.js";
import { useTaskFilter } from "./hooks/useTaskFilter.js";
import { Layout } from "./components/Layout.js";
import { TaskTreeHeader, TaskTreeBody } from "./components/TaskTree.js";
import { GanttChart, type GanttChartHandle } from "./components/GanttChart.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { Toolbar } from "./components/Toolbar.js";
import type { ViewScale } from "./hooks/useGanttScale.js";

export function App() {
  const { config, tasks, cache, loading, error, updateTask, refresh } = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [viewScale, setViewScale] = useState<ViewScale>("month");
  const [ganttHeader, setGanttHeader] = useState<React.ReactNode>(null);
  const ganttRef = useRef<GanttChartHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [syncing, setSyncing] = useState<"pull" | "push" | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleViewScaleChange = useCallback((scale: ViewScale) => {
    setViewScale(scale);
  }, []);

  const handleGanttHeader = useCallback((node: React.ReactNode) => {
    setGanttHeader(node);
  }, []);

  const { enabled, toggle: toggleType } = useTypeFilter(config?.task_types ?? {});
  const { displayOptions, toggleDisplayOption } = useDisplayOptions();
  const { hideClosed, toggleHideClosed, selectedAssignee, setSelectedAssignee, allAssignees } = useTaskFilter(tasks);
  const {
    flatList,
    collapsed,
    toggle: toggleCollapse,
    backlogFlatList,
    backlogCollapsed,
    backlogTotalCount,
    toggleBacklog,
  } = useTaskTree(tasks, enabled, { hideClosed, selectedAssignee });

  const handlePull = useCallback(async () => {
    setSyncing("pull");
    try {
      let res = await fetch("/api/sync/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        const data = await res.json();
        const confirmed = window.confirm(
          `${data.conflicts.length} task(s) have conflicting changes.\n\n` +
          data.conflicts.map((c: { taskId: string; title: string }) => `  - ${c.taskId}: ${c.title}`).join("\n") +
          "\n\nLocal changes to title, dates, state, etc. will be overwritten by remote.\n" +
          "Proceed with remote-wins merge?"
        );
        if (!confirmed) return;
        res = await fetch("/api/sync/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        showToast(`Pull failed: ${err?.error ?? res.statusText}`, "error");
        return;
      }
      const { added, updated, removed } = await res.json();
      await refresh();
      if (added === 0 && updated === 0 && removed === 0) {
        showToast("Pull complete: Already up to date.", "info");
      } else {
        showToast(`Pull complete: ${added} added, ${updated} updated, ${removed} removed`, "success");
      }
    } catch (err) {
      showToast(`Pull failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncing(null);
    }
  }, [refresh, showToast]);

  const handlePush = useCallback(async () => {
    setSyncing("push");
    try {
      const res = await fetch("/api/sync/push", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        showToast(`Push failed: ${err?.error ?? res.statusText}`, "error");
        return;
      }
      const data = await res.json();
      if (data.message) {
        showToast(data.message, "info");
      } else {
        showToast(`Push complete: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped`, "success");
      }
    } catch (err) {
      showToast(`Push failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncing(null);
    }
  }, [showToast]);

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
      {syncing && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9998,
          background: "rgba(255,255,255,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: 13, color: "#555", background: "#fff", padding: "8px 16px", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
            {syncing === "pull" ? "Pulling…" : "Pushing…"}
          </span>
        </div>
      )}
      {toast && (
        <div style={{
          position: "fixed", top: 12, right: 12, zIndex: 9999,
          padding: "10px 16px", borderRadius: 6, fontSize: 13,
          color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          background: toast.type === "success" ? "#27AE60"
            : toast.type === "error" ? "#e74c3c"
            : "#3498DB",
        }}>
          {toast.message}
        </div>
      )}
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
        syncing={syncing}
        displayOptions={displayOptions}
        onToggleDisplayOption={toggleDisplayOption}
        hideClosed={hideClosed}
        onToggleHideClosed={toggleHideClosed}
        selectedAssignee={selectedAssignee}
        allAssignees={allAssignees}
        onSelectAssignee={setSelectedAssignee}
      />
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Layout
          scrollContainerRef={scrollContainerRef}
          leftHeader={
            <TaskTreeHeader
              config={config}
              enabledTypes={enabled}
              onToggleType={toggleType}
            />
          }
          leftBody={
            <TaskTreeBody
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onDoubleClickTask={setDetailTaskId}
              flatList={flatList}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              backlogFlatList={backlogFlatList}
              backlogCollapsed={backlogCollapsed}
              backlogTotalCount={backlogTotalCount}
              onToggleBacklog={toggleBacklog}
              displayOptions={displayOptions}
              hoveredTaskId={hoveredTaskId}
              onHoverTask={setHoveredTaskId}
            />
          }
          rightHeader={ganttHeader}
          rightBody={
            <GanttChart
              ref={ganttRef}
              tasks={tasks}
              flatList={flatList}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onUpdateTask={(taskId, updates) => updateTask(taskId, updates)}
              onViewScaleChange={handleViewScaleChange}
              scrollContainerRef={scrollContainerRef}
              header={handleGanttHeader}
              backlogFlatList={backlogFlatList}
              backlogCollapsed={backlogCollapsed}
              backlogTotalCount={backlogTotalCount}
              displayOptions={displayOptions}
              hoveredTaskId={hoveredTaskId}
              onHoverTask={setHoveredTaskId}
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
