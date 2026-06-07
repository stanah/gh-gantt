import React, { useMemo, useState } from "react";
import type { ProjectMapViewModel, Task as SharedTask } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { useSyncStatus } from "../../hooks/useSyncStatus.js";
import { ProjectMapLayout } from "./ProjectMapLayout.js";
import { SystemTreePanel } from "./SystemTreePanel.js";
import { ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { DependencyMapPanel } from "./DependencyMapPanel.js";
import { NextActionsPanel } from "./NextActionsPanel.js";
import { CompactTimelinePanel } from "./CompactTimelinePanel.js";
import { ProjectMapToolbar, type ProjectMapFilterState } from "./ProjectMapToolbar.js";
import { taskMatchesFilter, filterHierarchy } from "./filter-util.js";

interface ProjectMapPageProps {
  viewModel: ProjectMapViewModel;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** 同期状態の再取得トリガー（pull/push 後に変化させる）。 */
  syncRefreshKey?: unknown;
}

/**
 * Project Map ビューのページ。ツールバー（検索・readiness フィルタ・同期状態）と
 * 5 パネルを配置し、ViewModel を各パネルへ配る。フィルタは Tree / Board / Next Actions /
 * Timeline に一貫適用される（Dependency Map は選択タスク中心のため選択スコープを優先）。
 */
export function ProjectMapPage({
  viewModel,
  config,
  selectedTaskId,
  onSelectTask,
  syncRefreshKey,
}: ProjectMapPageProps) {
  const [filter, setFilter] = useState<ProjectMapFilterState>({ search: "", readiness: null });
  const { status: syncStatus } = useSyncStatus(syncRefreshKey);

  // ViewModel の hierarchy ノードから全タスクを取り出す。
  const allTasks = useMemo(() => {
    const tasks: SharedTask[] = [];
    const walk = (nodes: ProjectMapViewModel["hierarchy"]) => {
      for (const node of nodes) {
        tasks.push(node.task);
        walk(node.children);
      }
    };
    walk(viewModel.hierarchy);
    return tasks;
  }, [viewModel.hierarchy]);

  const matchedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of allTasks) {
      if (taskMatchesFilter(task, viewModel.readinessById[task.id], filter)) ids.add(task.id);
    }
    return ids;
  }, [allTasks, viewModel.readinessById, filter]);

  const filteredTasks = useMemo(
    () => allTasks.filter((t) => matchedIds.has(t.id)),
    [allTasks, matchedIds],
  );
  const filteredHierarchy = useMemo(
    () => filterHierarchy(viewModel.hierarchy, matchedIds),
    [viewModel.hierarchy, matchedIds],
  );
  const filteredNextActions = useMemo(
    () => viewModel.nextActions.filter((a) => matchedIds.has(a.task.id)),
    [viewModel.nextActions, matchedIds],
  );

  return (
    <div
      data-testid="project-map-page"
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <ProjectMapToolbar
        filter={filter}
        onChange={setFilter}
        syncStatus={syncStatus}
        matchedCount={matchedIds.size}
        totalCount={allTasks.length}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ProjectMapLayout
          tree={
            <SystemTreePanel
              hierarchy={filteredHierarchy}
              readinessById={viewModel.readinessById}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          }
          board={
            <ProjectBoardPanel
              tasks={filteredTasks}
              readinessById={viewModel.readinessById}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          }
          dependency={
            <DependencyMapPanel
              tasks={allTasks}
              readinessById={viewModel.readinessById}
              config={config}
              criticalEdgeKeys={viewModel.criticalPath.criticalEdgeKeys}
              warnings={viewModel.warnings}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          }
          nextActions={
            <NextActionsPanel
              nextActions={filteredNextActions}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          }
          timeline={
            <CompactTimelinePanel
              tasks={filteredTasks}
              readinessById={viewModel.readinessById}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          }
        />
      </div>
    </div>
  );
}
