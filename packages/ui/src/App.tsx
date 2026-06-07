import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useApi } from "./hooks/useApi.js";
import { useTaskTree, type TaskSortMode } from "./hooks/useTaskTree.js";
import { extractMilestones, getMilestoneTypeNames } from "./lib/milestone-utils.js";
import { useTypeFilter } from "./hooks/useTypeFilter.js";
import { useDisplayOptions } from "./hooks/useDisplayOptions.js";
import { useTaskFilter } from "./hooks/useTaskFilter.js";
import { useRelatedTasks } from "./hooks/useRelatedTasks.js";
import { useTreeDragDrop } from "./hooks/useTreeDragDrop.js";
import { Layout } from "./components/Layout.js";
import { TaskTreeHeader, TaskTreeBody } from "./components/TaskTree.js";
import { GanttChart, type GanttChartHandle } from "./components/GanttChart.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { Toolbar } from "./components/toolbar/Toolbar.js";
import type { AppViewMode } from "./components/toolbar/ViewToggle.js";
import { ProjectMapPage } from "./components/project-map/ProjectMapPage.js";
import { useProjectMap } from "./hooks/useProjectMap.js";
import type { ViewScale } from "@gh-gantt/shared";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { ShortcutHelpPanel } from "./components/ShortcutHelpPanel.js";
import type { Task } from "./types/index.js";
import { useUndoRedo } from "./hooks/useUndoRedo.js";
import { SkeletonLoader } from "./components/SkeletonLoader.js";
import { ThemeProvider } from "./contexts/ThemeContext.js";
import { useCustomNonWorkingDays } from "./hooks/useCustomNonWorkingDays.js";
import { useHolidayPreset } from "./hooks/useHolidayPreset.js";
import { useFilterPresets, type FilterPresetState } from "./hooks/useFilterPresets.js";
import { useTaskDeepLink } from "./hooks/useTaskDeepLink.js";
import { downloadGanttExport } from "./lib/export-download.js";
import type { ExportRequest } from "./components/toolbar/ExportMenu.js";

const EMPTY_TASK_TYPES: Record<string, never> = {};

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

function buildTaskHistoryPatches(
  before: Task,
  after: Task,
): { undoPatch: Partial<Task>; redoPatch: Partial<Task> } {
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
  const { selectedTaskId, setSelectedTaskId } = useTaskDeepLink(tasks, { enabled: !loading });
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [detailPanelWidth, setDetailPanelWidth] = useState(400);
  const [viewScale, setViewScale] = useState<ViewScale>("month");
  const [viewMode, setViewMode] = useState<AppViewMode>("gantt");
  const [taskSortMode, setTaskSortMode] = useState<TaskSortMode>("default");
  const [labelGroupingEnabled, setLabelGroupingEnabled] = useState(false);
  const [ganttHeader, setGanttHeader] = useState<React.ReactNode>(null);
  const ganttRef = useRef<GanttChartHandle>(null);
  const hasScrolledToToday = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const [syncing, setSyncing] = useState<"pull" | "push" | null>(null);
  const { customDaysOff, addCustomDayOff, removeCustomDayOff } = useCustomNonWorkingDays();
  const { holidayPresetOptions, selectedHolidayPresetId, presetHolidays, selectHolidayPreset } =
    useHolidayPreset();
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
    if (!hasScrolledToToday.current) {
      hasScrolledToToday.current = true;
      requestAnimationFrame(() => ganttRef.current?.scrollToToday());
    }
  }, []);

  const handleGanttHeader = useCallback((node: React.ReactNode) => {
    setGanttHeader(node);
  }, []);

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId((prev) => (prev === taskId ? null : taskId));
  }, []);

  const handleDeselectTask = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const activateTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  const {
    enabled,
    toggle: toggleType,
    setEnabledTypes,
    enableAll: enableAllTypes,
  } = useTypeFilter(config?.task_types ?? {});
  const { displayOptions, toggleDisplayOption } = useDisplayOptions();
  const {
    hideClosed,
    setHideClosed,
    toggleHideClosed,
    dependencyHighlightEnabled,
    toggleDependencyHighlight,
    selectedAssignee,
    selectedAssignees,
    setSelectedAssignees,
    setSelectedAssignee,
    allAssignees,
    selectedPriorities,
    setSelectedPriorities,
    allLabels,
    selectedLabels,
    setSelectedLabels,
    searchQuery,
    setSearchQuery,
  } = useTaskFilter(tasks);
  const priorityFieldName = config?.sync?.field_mapping?.priority;
  const labelGroupingPrefix = config?.grouping?.label_prefix;
  const labelGrouping = useMemo(
    () => ({
      enabled: labelGroupingEnabled,
      labelPrefix: labelGroupingPrefix,
    }),
    [labelGroupingEnabled, labelGroupingPrefix],
  );
  const milestoneTypeNames = useMemo(
    () => (config ? getMilestoneTypeNames(config) : new Set<string>()),
    [config],
  );
  const {
    flatList,
    collapsed,
    toggle: toggleCollapse,
  } = useTaskTree(tasks, enabled, {
    hideClosed,
    selectedAssignee,
    selectedAssignees,
    selectedPriorities,
    priorityFieldName: priorityFieldName ?? undefined,
    selectedLabels,
    searchQuery,
    taskSortMode,
    labelGrouping,
    excludedTypes: milestoneTypeNames,
  });

  // 専用レーンに実際に表示されるマイルストーンの有無。TypeFilter (enabled) を反映し、
  // GanttChart 側の表示条件と一致させることで、左ヘッダーの高さ補正 (FR-VIS-023) を
  // 右ペインのレーン表示と確実に揃える。
  const hasMilestoneLane = useMemo(() => {
    if (!config) return false;
    return extractMilestones(tasks, config).some((m) => enabled.has(m.task.type));
  }, [tasks, config, enabled]);

  // Project Map ビュー用の派生 ViewModel（config 未取得時は null）。
  const projectMapViewModel = useProjectMap(tasks, config);

  const currentFilterPresetState = useMemo<FilterPresetState>(
    () => ({
      hideClosed,
      selectedAssignees,
      selectedPriorities,
      selectedLabels,
      enabledTypes: [...enabled].sort(),
      searchQuery,
      taskSortMode,
    }),
    [
      hideClosed,
      selectedAssignees,
      selectedPriorities,
      selectedLabels,
      enabled,
      searchQuery,
      taskSortMode,
    ],
  );

  const applyFilterPresetState = useCallback(
    (state: FilterPresetState) => {
      setHideClosed(state.hideClosed);
      setSelectedAssignees(state.selectedAssignees);
      setSelectedPriorities(state.selectedPriorities);
      setSelectedLabels(state.selectedLabels);
      setEnabledTypes(state.enabledTypes);
      setSearchQuery(state.searchQuery);
      setTaskSortMode(state.taskSortMode);
    },
    [
      setEnabledTypes,
      setHideClosed,
      setSearchQuery,
      setSelectedAssignees,
      setSelectedLabels,
      setSelectedPriorities,
    ],
  );

  const {
    presets: filterPresets,
    selectedPresetId: selectedFilterPresetId,
    savePreset: saveFilterPreset,
    applyPreset: applyFilterPreset,
    updatePreset: updateFilterPreset,
    renamePreset: renameFilterPreset,
    deletePreset: deleteFilterPreset,
    clearSelectedPreset: clearSelectedFilterPreset,
  } = useFilterPresets({
    currentState: currentFilterPresetState,
    onApplyPreset: applyFilterPresetState,
  });

  const visibleTaskNodes = useMemo(
    () => flatList.filter((node) => node.kind !== "group"),
    [flatList],
  );

  const visibleTaskIds = useMemo(
    () => visibleTaskNodes.map((node) => node.task.id),
    [visibleTaskNodes],
  );

  const visibleTaskMap = useMemo(
    () => new Map(visibleTaskNodes.map((node) => [node.task.id, node])),
    [visibleTaskNodes],
  );

  const exportVisibleNodes = useMemo(
    () => visibleTaskNodes.map((node) => ({ task: node.task, depth: node.depth })),
    [visibleTaskNodes],
  );

  const toggleSelectedCollapse = useCallback(
    (taskId: string) => {
      const node = visibleTaskMap.get(taskId);
      if (node && node.children.length > 0) {
        toggleCollapse(taskId);
      }
    },
    [toggleCollapse, visibleTaskMap],
  );

  const applyTrackedTaskUpdate = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
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
    },
    [pushHistory, tasks, updateTask],
  );

  const handleTaskUpdate = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
      if (undoRedoBusy) return;
      try {
        await applyTrackedTaskUpdate(taskId, updates);
      } catch (err) {
        showToast(`Update failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    [applyTrackedTaskUpdate, showToast, undoRedoBusy],
  );

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
    onUndo: () => {
      void handleUndo();
    },
    onRedo: () => {
      void handleRedo();
    },
  });

  const { getRelated } = useRelatedTasks(tasks, config?.task_types ?? EMPTY_TASK_TYPES);
  const { ids: highlightedTaskIds, relationMap: highlightRelationMap } = useMemo(
    () => getRelated(dependencyHighlightEnabled ? hoveredTaskId : null),
    [dependencyHighlightEnabled, getRelated, hoveredTaskId],
  );

  const handleReparent = useCallback(
    async (taskId: string, newParentId: string | null) => {
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
    },
    [pushHistory, reparentTask, showToast, tasks, undoRedoBusy],
  );

  const handleAddDependency = useCallback(
    async (taskId: string, blockedByTaskId: string) => {
      if (undoRedoBusy) return;
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) {
        showToast("Task not found", "error");
        return;
      }
      if (task.blocked_by.some((d) => d.task === blockedByTaskId)) return;

      const newBlockedBy = [
        ...task.blocked_by,
        { task: blockedByTaskId, type: "finish-to-start" as const, lag: 0 },
      ];
      try {
        await applyTrackedTaskUpdate(taskId, { blocked_by: newBlockedBy });
        showToast(`依存関係を追加: ${blockedByTaskId}`, "success");
      } catch (err) {
        showToast(
          `依存関係の追加に失敗: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [applyTrackedTaskUpdate, showToast, tasks, undoRedoBusy],
  );

  const dragState = useTreeDragDrop({
    tasks,
    config,
    onReparent: handleReparent,
    onAddDependency: handleAddDependency,
  });

  useEffect(() => {
    if (!selectedTaskId) return;
    const selectedRow = document.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(selectedTaskId)}"]`,
    );
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
            data.conflicts
              .map((c: { taskId: string; title: string }) => `  - ${c.taskId}: ${c.title}`)
              .join("\n") +
            "\n\nLocal changes to title, dates, state, etc. will be overwritten by remote.\n" +
            "Proceed with remote-wins merge?",
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
        showToast(
          `Pull complete: ${added} added, ${updated} updated, ${removed} removed`,
          "success",
        );
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

      if (
        preview.summary.create === 0 &&
        preview.summary.update === 0 &&
        (preview.summary.skip ?? 0) === 0
      ) {
        showToast("No local changes to push.", "info");
        return;
      }

      // Step 2: Confirm
      const lines = preview.changes.map(
        (c: { type: string; title: string; changedFields?: string[] }) =>
          `  ${c.type === "added" ? "+" : c.type === "deleted" ? "-" : "~"} ${c.title}${c.changedFields ? ` [${c.changedFields.join(", ")}]` : ""}`,
      );
      const totalCount =
        preview.summary.create + preview.summary.update + (preview.summary.skip ?? 0);
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
        showToast(
          `Push complete: ${data.created} created, ${data.updated} updated, ${data.skipped} skipped`,
          "success",
        );
      }
      await refresh();
    } catch (err) {
      showToast(`Push failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncing(null);
    }
  }, [clearHistory, refresh, showToast]);

  const handleExport = useCallback(
    async (request: ExportRequest) => {
      if (!config) return;
      try {
        await downloadGanttExport({
          tasks,
          visibleNodes: exportVisibleNodes,
          config,
          request,
          viewScale,
        });
        showToast(`Exported ${request.format.toUpperCase()}`, "success");
      } catch (err) {
        showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    [config, exportVisibleNodes, showToast, tasks, viewScale],
  );

  const hasActiveFilters = useMemo(() => {
    const allTypeCount = Object.keys(config?.task_types ?? {}).length;
    return (
      hideClosed ||
      searchQuery.trim() !== "" ||
      selectedAssignees.length > 0 ||
      selectedPriorities.length > 0 ||
      selectedLabels.length > 0 ||
      taskSortMode !== "default" ||
      (allTypeCount > 0 && enabled.size < allTypeCount)
    );
  }, [
    hideClosed,
    searchQuery,
    selectedAssignees,
    selectedPriorities,
    selectedLabels,
    taskSortMode,
    enabled,
    config,
  ]);

  const resetAllFilters = useCallback(() => {
    setHideClosed(false);
    setSearchQuery("");
    setSelectedAssignee(null);
    setSelectedPriorities([]);
    setSelectedLabels([]);
    setTaskSortMode("default");
    enableAllTypes();
    clearSelectedFilterPreset();
  }, [
    setHideClosed,
    setSearchQuery,
    setSelectedAssignee,
    setSelectedPriorities,
    setSelectedLabels,
    setTaskSortMode,
    enableAllTypes,
    clearSelectedFilterPreset,
  ]);

  return (
    <ThemeProvider>
      {loading ? (
        <SkeletonLoader />
      ) : error ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--color-danger)",
          }}
        >
          Error: {error}
        </div>
      ) : !config ? null : (
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          {syncing && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9998,
                background: "rgba(128,128,128,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  color: "var(--color-text-secondary)",
                  background: "var(--color-surface)",
                  padding: "8px 16px",
                  borderRadius: 6,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                }}
              >
                {syncing === "pull" ? "Pulling…" : "Pushing…"}
              </span>
            </div>
          )}
          {toast && (
            <div
              style={{
                position: "fixed",
                top: 12,
                right: 12,
                zIndex: 9999,
                padding: "10px 16px",
                borderRadius: 6,
                fontSize: 13,
                color: "#fff",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                background:
                  toast.type === "success"
                    ? "var(--color-success)"
                    : toast.type === "error"
                      ? "var(--color-danger)"
                      : "var(--color-info)",
              }}
            >
              {toast.message}
            </div>
          )}
          <Toolbar
            projectName={config.project.name}
            taskCount={tasks.length}
            activeScale={viewScale}
            onScaleChange={(scale) => ganttRef.current?.setViewScale(scale)}
            onScrollToToday={() => ganttRef.current?.scrollToToday()}
            onPull={handlePull}
            onPush={handlePush}
            syncing={syncing}
            displayOptions={displayOptions}
            onToggleDisplayOption={toggleDisplayOption}
            dependencyHighlightEnabled={dependencyHighlightEnabled}
            onToggleDependencyHighlight={toggleDependencyHighlight}
            hideClosed={hideClosed}
            onToggleHideClosed={toggleHideClosed}
            selectedAssignee={selectedAssignee}
            allAssignees={allAssignees}
            onSelectAssignee={setSelectedAssignee}
            {...(priorityFieldName
              ? {
                  selectedPriorities,
                  onSelectPriorities: setSelectedPriorities,
                }
              : {})}
            allLabels={allLabels}
            selectedLabels={selectedLabels}
            onSelectLabels={setSelectedLabels}
            labelGroupingPrefix={labelGroupingPrefix}
            labelGroupingEnabled={labelGroupingEnabled}
            onToggleLabelGrouping={() => setLabelGroupingEnabled((prev) => !prev)}
            filterPresets={filterPresets}
            selectedFilterPresetId={selectedFilterPresetId}
            onApplyFilterPreset={applyFilterPreset}
            onSaveFilterPreset={saveFilterPreset}
            onUpdateFilterPreset={updateFilterPreset}
            onRenameFilterPreset={renameFilterPreset}
            onDeleteFilterPreset={deleteFilterPreset}
            onClearFilters={resetAllFilters}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            taskSortMode={taskSortMode}
            onTaskSortModeChange={setTaskSortMode}
            searchInputRef={searchInputRef}
            onOpenShortcuts={toggleHelp}
            onUndo={() => {
              void handleUndo();
            }}
            onRedo={() => {
              void handleRedo();
            }}
            canUndo={canUndo}
            canRedo={canRedo}
            undoCount={undoCount}
            redoCount={redoCount}
            undoRedoBusy={undoRedoBusy}
            taskTypes={config?.task_types ?? {}}
            sprints={config?.sprints}
            enabledTypes={enabled}
            onToggleType={toggleType}
            configuredHolidays={config.gantt.holidays ?? []}
            holidayPresetOptions={holidayPresetOptions}
            selectedHolidayPresetId={selectedHolidayPresetId}
            presetHolidays={presetHolidays}
            onSelectHolidayPreset={selectHolidayPreset}
            customDaysOff={customDaysOff}
            onAddCustomDayOff={addCustomDayOff}
            onRemoveCustomDayOff={removeCustomDayOff}
            onExport={(request) => {
              void handleExport(request);
            }}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
          <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
            {viewMode === "project-map" ? (
              <div style={{ flex: 1, overflow: "hidden" }}>
                {projectMapViewModel ? (
                  <ProjectMapPage
                    viewModel={projectMapViewModel}
                    config={config}
                    selectedTaskId={selectedTaskId}
                    onSelectTask={handleSelectTask}
                    syncRefreshKey={syncing}
                  />
                ) : null}
              </div>
            ) : (
              <div
                style={{ flex: 1, overflow: "hidden" }}
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest("button, a, input, select, textarea")) return;
                  handleDeselectTask();
                }}
              >
                <Layout
                  scrollContainerRef={scrollContainerRef}
                  leftHeader={
                    <TaskTreeHeader config={config} hasMilestoneLane={hasMilestoneLane} />
                  }
                  leftBody={
                    <TaskTreeBody
                      config={config}
                      selectedTaskId={selectedTaskId}
                      onSelectTask={handleSelectTask}
                      flatList={flatList}
                      collapsed={collapsed}
                      onToggleCollapse={toggleCollapse}
                      displayOptions={displayOptions}
                      hoveredTaskId={hoveredTaskId}
                      onHoverTask={setHoveredTaskId}
                      dependencyHighlightEnabled={dependencyHighlightEnabled}
                      highlightedTaskIds={highlightedTaskIds}
                      highlightRelationMap={highlightRelationMap}
                      searchQuery={searchQuery}
                      dragState={dragState}
                      totalTaskCount={tasks.length}
                      hasActiveFilters={hasActiveFilters}
                      onResetFilters={resetAllFilters}
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
                      onUpdateTask={(taskId, updates) => {
                        void handleTaskUpdate(taskId, updates);
                      }}
                      onViewScaleChange={handleViewScaleChange}
                      scrollContainerRef={scrollContainerRef}
                      header={handleGanttHeader}
                      displayOptions={displayOptions}
                      hoveredTaskId={hoveredTaskId}
                      onHoverTask={setHoveredTaskId}
                      dependencyHighlightEnabled={dependencyHighlightEnabled}
                      highlightRelationMap={highlightRelationMap}
                      presetHolidays={presetHolidays}
                      customDaysOff={customDaysOff}
                      enabledTypes={enabled}
                    />
                  }
                />
              </div>
            )}
            {selectedTaskId &&
              (() => {
                const detailTask = tasks.find((t) => t.id === selectedTaskId);
                if (!detailTask) return null;
                return (
                  <TaskDetailPanel
                    key={selectedTaskId}
                    task={detailTask}
                    config={config}
                    comments={cache.comments[selectedTaskId] ?? []}
                    allTasks={tasks}
                    onUpdate={(updates) => {
                      void handleTaskUpdate(selectedTaskId, updates);
                    }}
                    onClose={handleDeselectTask}
                    onSelectTask={handleSelectTask}
                    width={detailPanelWidth}
                    onWidthChange={setDetailPanelWidth}
                  />
                );
              })()}
          </div>
          <ShortcutHelpPanel open={isHelpOpen} onClose={closeHelp} />
        </div>
      )}
    </ThemeProvider>
  );
}
