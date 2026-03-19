import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useApi } from "./hooks/useApi.js";
import { useTaskTree } from "./hooks/useTaskTree.js";
import { useTypeFilter } from "./hooks/useTypeFilter.js";
import { useDisplayOptions } from "./hooks/useDisplayOptions.js";
import { useTaskFilter } from "./hooks/useTaskFilter.js";
import { useRelatedTasks } from "./hooks/useRelatedTasks.js";
import { useTreeDragDrop } from "./hooks/useTreeDragDrop.js";
import { Layout } from "./components/Layout.js";
import { TaskTreeHeader, TaskTreeBody } from "./components/TaskTree.js";
import { GanttChart, type GanttChartHandle } from "./components/GanttChart.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { Toolbar } from "./components/Toolbar.js";
import type { ViewScale } from "./hooks/useGanttScale.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { ShortcutHelpPanel } from "./components/ShortcutHelpPanel.js";
import type { Task } from "./types/index.js";
import { useUndoRedo } from "./hooks/useUndoRedo.js";

const TRACKED_TASK_FIELDS = [
  "title",
  "body",
  "state",
  "state_reason",
  "assignees",
  "labels",
  "milestone",
  "custom_fields",
  "start_date",
  "end_date",
  "date",
  "blocked_by",
] as const satisfies ReadonlyArray<keyof Task>;

function cloneHistoryValue<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildTaskHistoryPatches(before: Task, after: Task): { undoPatch: Partial<Task>; redoPatch: Partial<Task> } {
  const undoPatch: Partial<Task> = {};
  const redoPatch: Partial<Task> = {};
  const undoRecord = undoPatch as Record<string, unknown>;
  const redoRecord = redoPatch as Record<string, unknown>;

  for (const field of TRACKED_TASK_FIELDS) {
    if (!valuesEqual(before[field], after[field])) {
      undoRecord[field] = cloneHistoryValue(before[field]);
      redoRecord[field] = cloneHistoryValue(after[field]);
    }
  }

  return { undoPatch, redoPatch };
}

export function App() {
  const { config, tasks, cache, loading, error, updateTask, refresh, reparentTask } = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [viewScale, setViewScale] = useState<ViewScale>("month");
  const [ganttHeader, setGanttHeader] = useState<React.ReactNode>(null);
  const ganttRef = useRef<GanttChartHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [syncing, setSyncing] = useState<"pull" | "push" | null>(null);
  const {
    canUndo,
    canRedo,
    undoCount,
    redoCount,
    isApplying: undoRedoBusy,
    push: pushHistory,
    undo,
    redo,
    clearAll: clearHistory,
  } = useUndoRedo();

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

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId));
  }, []);

  const activateTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  const { enabled, toggle: toggleType } = useTypeFilter(config?.task_types ?? {});
  const { displayOptions, toggleDisplayOption } = useDisplayOptions();
  const {
    hideClosed,
    toggleHideClosed,
    selectedAssignee,
    selectedAssignees,
    setSelectedAssignee,
    allAssignees,
    searchQuery,
    setSearchQuery,
  } = useTaskFilter(tasks);
  const {
    flatList,
    collapsed,
    toggle: toggleCollapse,
    backlogFlatList,
    backlogCollapsed,
    backlogTotalCount,
    toggleBacklog,
  } = useTaskTree(tasks, enabled, { hideClosed, selectedAssignee, selectedAssignees, searchQuery });

  const visibleTaskIds = useMemo(
    () => [
      ...flatList.map((node) => node.task.id),
      ...(!backlogCollapsed ? backlogFlatList.map((node) => node.task.id) : []),
    ],
    [backlogCollapsed, backlogFlatList, flatList],
  );

  const visibleTaskMap = useMemo(
    () => new Map(
      [...flatList, ...(!backlogCollapsed ? backlogFlatList : [])].map((node) => [node.task.id, node]),
    ),
    [backlogCollapsed, backlogFlatList, flatList],
  );

  const toggleSelectedCollapse = useCallback((taskId: string) => {
    const node = visibleTaskMap.get(taskId);
    if (node && node.children.length > 0) {
      toggleCollapse(taskId);
    }
  }, [toggleCollapse, visibleTaskMap]);

  const applyTrackedTaskUpdate = useCallback(async (taskId: string, updates: Partial<Task>) => {
    const beforeTask = tasks.find((task) => task.id === taskId);
    if (!beforeTask) {
      throw new Error("Task not found");
    }

    const updatedTask = await updateTask(taskId, updates);
    const { undoPatch, redoPatch } = buildTaskHistoryPatches(beforeTask, updatedTask);

    if (Object.keys(redoPatch).length > 0) {
      pushHistory({
        label: beforeTask.title,
        undo: async () => {
          await updateTask(taskId, undoPatch);
        },
        redo: async () => {
          await updateTask(taskId, redoPatch);
        },
      });
    }

    return updatedTask;
  }, [pushHistory, tasks, updateTask]);

  const handleTaskUpdate = useCallback(async (taskId: string, updates: Partial<Task>) => {
    if (undoRedoBusy) return;
    try {
      await applyTrackedTaskUpdate(taskId, updates);
    } catch (err) {
      showToast(`Update failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [applyTrackedTaskUpdate, showToast, undoRedoBusy]);

  const handleUndo = useCallback(async () => {
    try {
      await undo();
    } catch (err) {
      showToast(`Undo failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [showToast, undo]);

  const handleRedo = useCallback(async () => {
    try {
      await redo();
    } catch (err) {
      showToast(`Redo failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [redo, showToast]);

  const { isHelpOpen, closeHelp, toggleHelp } = useKeyboardShortcuts({
    orderedTaskIds: visibleTaskIds,
    selectedTaskId,
    onSelectTask: activateTask,
    onToggleCollapse: toggleSelectedCollapse,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onUndo: () => { void handleUndo(); },
    onRedo: () => { void handleRedo(); },
  });

  const { getRelated } = useRelatedTasks(tasks);
  const { ids: highlightedTaskIds, relationMap: highlightRelationMap } = useMemo(
    () => getRelated(hoveredTaskId),
    [getRelated, hoveredTaskId],
  );

  const handleReparent = useCallback(async (taskId: string, newParentId: string | null) => {
    if (undoRedoBusy) return;
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      showToast("Task not found", "error");
      return;
    }
    const previousParentId = task.parent ?? null;
    if (previousParentId === newParentId) return;

    try {
      await reparentTask(taskId, newParentId);
      pushHistory({
        label: `Reparent ${task.title}`,
        undo: async () => {
          await reparentTask(taskId, previousParentId);
        },
        redo: async () => {
          await reparentTask(taskId, newParentId);
        },
      });
    } catch (err) {
      showToast(`Reparent failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [pushHistory, reparentTask, showToast, tasks, undoRedoBusy]);

  const dragState = useTreeDragDrop({
    tasks,
    config,
    onReparent: handleReparent,
  });

  useEffect(() => {
    if (!selectedTaskId) return;
    const selectedRow = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedTaskId)}"]`);
    selectedRow?.scrollIntoView({ block: "nearest" });
  }, [selectedTaskId, visibleTaskIds]);

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
        clearHistory();
        showToast(`Pull complete: ${added} added, ${updated} updated, ${removed} removed`, "success");
      }
    } catch (err) {
      showToast(`Pull failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncing(null);
    }
  }, [clearHistory, refresh, showToast]);

  const handlePush = useCallback(async () => {
    setSyncing("push");
    try {
      // Step 1: Preview with dry_run
      const previewRes = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      });
      if (!previewRes.ok) {
        const err = await previewRes.json().catch(() => null);
        showToast(`Push failed: ${err?.error ?? previewRes.statusText}`, "error");
        return;
      }
      const preview = await previewRes.json();

      if (preview.summary.create === 0 && preview.summary.update === 0 && (preview.summary.skip ?? 0) === 0) {
        showToast("No local changes to push.", "info");
        return;
      }

      // Step 2: Confirm
      const lines = preview.changes.map(
        (c: { type: string; title: string; changedFields?: string[] }) =>
          `  ${c.type === "added" ? "+" : c.type === "deleted" ? "-" : "~"} ${c.title}${c.changedFields ? ` [${c.changedFields.join(", ")}]` : ""}`,
      );
      const totalCount = preview.summary.create + preview.summary.update + (preview.summary.skip ?? 0);
      const msg =
        `Push ${totalCount} task(s) to GitHub?\n\n` +
        `  Create: ${preview.summary.create}\n` +
        `  Update: ${preview.summary.update}\n` +
        (preview.summary.skip ? `  Skip/Delete: ${preview.summary.skip}\n` : "") +
        `  Estimated API calls: ~${preview.estimated_api_calls}\n\n` +
        lines.join("\n");

      if (!window.confirm(msg)) {
        showToast("Push cancelled.", "info");
        return;
      }

      // Step 3: Execute
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        showToast(`Push failed: ${err?.error ?? res.statusText}`, "error");
        return;
      }
      const data = await res.json();
      if (data.message) {
        clearHistory();
        showToast(data.message, "info");
      } else {
        clearHistory();
        showToast(`Push complete: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped`, "success");
      }
      await refresh();
    } catch (err) {
      showToast(`Push failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncing(null);
    }
  }, [clearHistory, refresh, showToast]);

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
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchInputRef={searchInputRef}
        onOpenShortcuts={toggleHelp}
        onUndo={() => { void handleUndo(); }}
        onRedo={() => { void handleRedo(); }}
        canUndo={canUndo}
        canRedo={canRedo}
        undoCount={undoCount}
        redoCount={redoCount}
        undoRedoBusy={undoRedoBusy}
      />
      <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
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
                onSelectTask={handleSelectTask}
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
                highlightedTaskIds={highlightedTaskIds}
                highlightRelationMap={highlightRelationMap}
                searchQuery={searchQuery}
                dragState={dragState}
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
                onSelectTask={handleSelectTask}
                onUpdateTask={(taskId, updates) => { void handleTaskUpdate(taskId, updates); }}
                onViewScaleChange={handleViewScaleChange}
                scrollContainerRef={scrollContainerRef}
                header={handleGanttHeader}
                backlogFlatList={backlogFlatList}
                backlogCollapsed={backlogCollapsed}
                backlogTotalCount={backlogTotalCount}
                displayOptions={displayOptions}
                hoveredTaskId={hoveredTaskId}
                onHoverTask={setHoveredTaskId}
                highlightRelationMap={highlightRelationMap}
              />
            }
          />
        </div>
        {selectedTaskId && (() => {
          const detailTask = tasks.find((t) => t.id === selectedTaskId);
          if (!detailTask) return null;
          return (
            <TaskDetailPanel
              key={selectedTaskId}
              task={detailTask}
              config={config}
              comments={cache.comments[selectedTaskId] ?? []}
              onUpdate={(updates) => { void handleTaskUpdate(selectedTaskId, updates); }}
              onClose={() => setSelectedTaskId(null)}
            />
          );
        })()}
      </div>
      <ShortcutHelpPanel open={isHelpOpen} onClose={closeHelp} />
    </div>
  );
}
