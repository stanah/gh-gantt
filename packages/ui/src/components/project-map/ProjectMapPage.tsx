import React, { useEffect, useMemo, useState } from "react";
import {
  groupTasks,
  getGroupDimensions,
  resolveInheritedMilestones,
  type GroupDimension,
  type ProjectMapRunGraphViewModel,
  type ProjectMapViewModel,
  type Task as SharedTask,
} from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { useSyncStatus } from "../../hooks/useSyncStatus.js";
import { useProjectMapLayout } from "../../hooks/useProjectMapLayout.js";
import { getMilestoneTypeNames } from "../../lib/milestone-utils.js";
import { ProjectMapLayout } from "./ProjectMapLayout.js";
import { ProjectMapLayoutSettings } from "./ProjectMapLayoutSettings.js";
import { SystemTreePanel } from "./SystemTreePanel.js";
import { ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { DependencyMapPanel } from "./DependencyMapPanel.js";
import { NextActionsPanel } from "./NextActionsPanel.js";
import { CompactTimelinePanel } from "./CompactTimelinePanel.js";
import { ProjectMapToolbar, type ProjectMapTypeOption } from "./ProjectMapToolbar.js";
import {
  createDefaultProjectMapFilter,
  taskMatchesFilter,
  filterHierarchy,
  type ProjectMapFilterState,
} from "./filter-util.js";
import { RunGraphPanel } from "./RunGraphPanel.js";

interface ProjectMapPageProps {
  viewModel: ProjectMapViewModel;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  runGraphViewModel?: ProjectMapRunGraphViewModel | null;
  runGraphLoading?: boolean;
  runGraphError?: string | null;
  onSelectRun?: (runId: string) => void;
  onSelectRunNode?: (nodeId: string) => void;
  /** 同期状態の再取得トリガー（pull/push 後に変化させる）。 */
  syncRefreshKey?: unknown;
}

/**
 * Project Map ビューのページ。ツールバー（検索・readiness / タイプ フィルタ・同期状態）と
 * 6 パネルを配置し、ViewModel を各パネルへ配る。フィルタは Tree / Board / Next Actions /
 * Timeline / Dependency Map に一貫適用される（Dependency Map は選択タスク中心の絞り込みと
 * 直交し、除外ノードを経由する依存は途切れとして示す）。
 * フィルタ状態は Gantt ビューの TypeFilter / hideClosed とは独立に Project Map 内で保持する。
 * マイルストーン絞り込みは shared の resolveInheritedMilestones で祖先から継承した値で判定し、
 * マイルストーン型（display: "milestone"）のタスクは既定で Dependency Map のノードから除外する。
 * パネル構成（表示 / 並び順 / サイズ）は useProjectMapLayout で localStorage に保存・復元する。
 */
export function ProjectMapPage({
  viewModel,
  config,
  selectedTaskId,
  onSelectTask,
  runGraphViewModel = null,
  runGraphLoading = false,
  runGraphError = null,
  onSelectRun = () => undefined,
  onSelectRunNode = () => undefined,
  syncRefreshKey,
}: ProjectMapPageProps) {
  const [filter, setFilter] = useState<ProjectMapFilterState>(createDefaultProjectMapFilter);
  const [groupDimension, setGroupDimension] = useState<GroupDimension>("hierarchy");
  const { status: syncStatus } = useSyncStatus(syncRefreshKey);
  const layout = useProjectMapLayout();
  const [layoutSettingsOpen, setLayoutSettingsOpen] = useState(false);

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

  // タイプ絞り込みの選択肢は config.task_types から作る。
  const typeOptions = useMemo<ProjectMapTypeOption[]>(
    () =>
      Object.entries(config.task_types).map(([value, def]) => ({
        value,
        label: def.label ?? value,
        color: def.color,
      })),
    [config.task_types],
  );

  // Group by 軸 = 組み込み + config facets + ラベルから自動検出した namespace facets。
  const groupDimensions = useMemo(() => getGroupDimensions(config, allTasks), [config, allTasks]);

  // 選択中の軸が候補から消えた場合（facet 削除・データ変化など）は hierarchy に戻す。
  useEffect(() => {
    if (!groupDimensions.some((d) => d.value === groupDimension)) {
      setGroupDimension("hierarchy");
    }
  }, [groupDimensions, groupDimension]);

  // マイルストーンは親子関係で継承して解決する（blocked_by は辿らない）。
  const inheritedMilestones = useMemo(() => resolveInheritedMilestones(allTasks), [allTasks]);
  const milestoneOptions = useMemo(
    () =>
      [...new Set([...inheritedMilestones.values()].filter((m): m is string => m != null))].sort(),
    [inheritedMilestones],
  );

  // マイルストーン型（display: "milestone"）のタスク ID。Dependency Map では既定で非表示。
  const milestoneTaskIds = useMemo(() => {
    const typeNames = getMilestoneTypeNames(config);
    return new Set(allTasks.filter((t) => typeNames.has(t.type)).map((t) => t.id));
  }, [allTasks, config]);

  const matchedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of allTasks) {
      if (
        taskMatchesFilter(
          task,
          viewModel.readinessById[task.id],
          filter,
          inheritedMilestones.get(task.id) ?? null,
        )
      ) {
        ids.add(task.id);
      }
    }
    return ids;
  }, [allTasks, viewModel.readinessById, filter, inheritedMilestones]);

  // Dependency Map に渡す表示集合。マイルストーン型はトグルが無効なら除外する。
  const dependencyVisibleIds = useMemo(() => {
    if (filter.showMilestoneTypes || milestoneTaskIds.size === 0) return matchedIds;
    return new Set([...matchedIds].filter((id) => !milestoneTaskIds.has(id)));
  }, [matchedIds, milestoneTaskIds, filter.showMilestoneTypes]);

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

  // Group by 軸が hierarchy 以外のとき、フィルタ後タスクを軸でグルーピングする。
  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const treeGroups = useMemo(
    () =>
      groupDimension === "hierarchy"
        ? null
        : groupTasks(filteredTasks, groupDimension, config).groups,
    [groupDimension, filteredTasks, config],
  );

  return (
    <div
      data-testid="project-map-page"
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <ProjectMapToolbar
        filter={filter}
        onChange={setFilter}
        typeOptions={typeOptions}
        milestoneOptions={milestoneOptions}
        hasMilestoneTypes={milestoneTaskIds.size > 0}
        groupDimension={groupDimension}
        onGroupDimensionChange={setGroupDimension}
        groupDimensions={groupDimensions}
        syncStatus={syncStatus}
        matchedCount={matchedIds.size}
        totalCount={allTasks.length}
        layoutSettingsOpen={layoutSettingsOpen}
        onToggleLayoutSettings={() => setLayoutSettingsOpen((open) => !open)}
      />
      {layoutSettingsOpen && (
        <ProjectMapLayoutSettings
          settings={layout.settings}
          onSetPanelVisible={layout.setPanelVisible}
          onSetPanelSize={layout.setPanelSize}
          onMovePanel={layout.movePanel}
          onApplyPreset={layout.applyPreset}
          onReset={layout.resetToDefault}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ProjectMapLayout
          settings={layout.settings}
          tree={
            <SystemTreePanel
              hierarchy={filteredHierarchy}
              groups={treeGroups}
              taskById={taskById}
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
              groups={treeGroups}
              taskById={taskById}
            />
          }
          dependency={
            <DependencyMapPanel
              tasks={allTasks}
              visibleTaskIds={dependencyVisibleIds}
              milestoneTaskIds={milestoneTaskIds}
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
          runGraph={
            <RunGraphPanel
              viewModel={runGraphViewModel}
              loading={runGraphLoading}
              error={runGraphError}
              onSelectRun={onSelectRun}
              onSelectNode={onSelectRunNode}
            />
          }
        />
      </div>
    </div>
  );
}
