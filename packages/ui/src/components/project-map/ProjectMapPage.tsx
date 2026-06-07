import React from "react";
import type { ProjectMapViewModel } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { ProjectMapLayout } from "./ProjectMapLayout.js";
import { SystemTreePanel } from "./SystemTreePanel.js";
import { ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { DependencyMapPanel } from "./DependencyMapPanel.js";
import { NextActionsPanel } from "./NextActionsPanel.js";
import { CompactTimelinePanel } from "./CompactTimelinePanel.js";

interface ProjectMapPageProps {
  viewModel: ProjectMapViewModel;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/**
 * Project Map ビューのページ。ViewModel を各パネルへ配り、5 パネルを
 * {@link ProjectMapLayout} に配置する。選択タスクは全パネルで共有される。
 */
export function ProjectMapPage({
  viewModel,
  config,
  selectedTaskId,
  onSelectTask,
}: ProjectMapPageProps) {
  // ViewModel の hierarchy ノードから、依存/ボード/タイムラインで使う全タスクを取り出す。
  const allTasks = React.useMemo(() => {
    const tasks: ProjectMapViewModel["hierarchy"][number]["task"][] = [];
    const walk = (nodes: ProjectMapViewModel["hierarchy"]) => {
      for (const node of nodes) {
        tasks.push(node.task);
        walk(node.children);
      }
    };
    walk(viewModel.hierarchy);
    return tasks;
  }, [viewModel.hierarchy]);

  return (
    <div data-testid="project-map-page" style={{ height: "100%", minHeight: 0 }}>
      <ProjectMapLayout
        tree={
          <SystemTreePanel
            hierarchy={viewModel.hierarchy}
            readinessById={viewModel.readinessById}
            config={config}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        }
        board={
          <ProjectBoardPanel
            tasks={allTasks}
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
            nextActions={viewModel.nextActions}
            config={config}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        }
        timeline={
          <CompactTimelinePanel
            tasks={allTasks}
            readinessById={viewModel.readinessById}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        }
      />
    </div>
  );
}
