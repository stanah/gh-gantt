import React, { useMemo } from "react";
import {
  buildBoardColumns,
  BOARD_COLUMN_ORDER,
  collectSubtreeIds,
  type BoardColumnId,
  type Task as SharedTask,
  type TaskReadiness,
} from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelEmpty } from "./ProjectMapLayout.js";
import { ProjectBoardColumn } from "./ProjectBoardColumn.js";

interface ProjectBoardPanelProps {
  tasks: SharedTask[];
  readinessById: Record<string, TaskReadiness>;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

// 個別タスクではなく構造を表すコンテナ型はボードに出さない。
const CONTAINER_TYPES = new Set(["epic", "summary"]);

/** ボードに表示する列（backlog は件数があるときのみ後述で出す）。 */
const VISIBLE_COLUMNS: BoardColumnId[] = BOARD_COLUMN_ORDER.filter((c) => c !== "backlog");

/**
 * Project Board パネル。選択中 Feature の子孫タスク（未選択なら全タスク）を
 * Ready Now / In Progress / Review / Blocked / Done の列に分類して表示する。
 * 依存解除済みで着手可能なタスクだけが Ready Now に並ぶ。
 */
export function ProjectBoardPanel({
  tasks,
  readinessById,
  config,
  selectedTaskId,
  onSelectTask,
}: ProjectBoardPanelProps) {
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const scopedTasks = useMemo(() => {
    let scope = tasks;
    if (selectedTaskId && taskById.has(selectedTaskId)) {
      const ids = collectSubtreeIds(selectedTaskId, taskById);
      scope = tasks.filter((t) => ids.has(t.id));
    }
    return scope.filter((t) => !CONTAINER_TYPES.has(t.type) && t.type !== "milestone");
  }, [tasks, taskById, selectedTaskId]);

  const columns = useMemo(
    () => buildBoardColumns(scopedTasks, config, tasks),
    [scopedTasks, config, tasks],
  );

  const visibleColumns = useMemo(() => {
    const cols = [...VISIBLE_COLUMNS];
    if (columns.backlog.length > 0) cols.push("backlog");
    return cols;
  }, [columns.backlog.length]);

  const hint = selectedTaskId ? "選択サブツリー" : "全タスク";

  return (
    <>
      <PanelHeader title="Project Board" hint={hint} />
      {scopedTasks.length === 0 ? (
        <PanelEmpty message="表示するタスクがありません" />
      ) : (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 8,
            overflow: "auto",
            flex: 1,
            minHeight: 0,
          }}
        >
          {visibleColumns.map((column) => (
            <ProjectBoardColumn
              key={column}
              column={column}
              tasks={columns[column]}
              readinessById={readinessById}
              taskById={taskById}
              config={config}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          ))}
        </div>
      )}
    </>
  );
}
