import React, { useMemo } from "react";
import {
  BOARD_COLUMN_ORDER,
  collectSubtreeIds,
  type BoardColumnId,
  type TaskGroup,
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
  /** Group by 軸が hierarchy 以外のとき非 null。各グループをスイムレーンとして表示する。 */
  groups?: TaskGroup[] | null;
  /** groups 指定時のタスク解決用。 */
  taskById?: Map<string, SharedTask>;
}

// 個別タスクではなく構造を表すコンテナ型はボードに出さない。
const CONTAINER_TYPES = new Set(["epic", "summary"]);

const isBoardTask = (task: SharedTask): boolean =>
  !CONTAINER_TYPES.has(task.type) && task.type !== "milestone";

function buildColumns(
  tasks: SharedTask[],
  readinessById: Record<string, TaskReadiness>,
): Record<BoardColumnId, SharedTask[]> {
  const cols: Record<BoardColumnId, SharedTask[]> = {
    ready_now: [],
    in_progress: [],
    review: [],
    blocked: [],
    done: [],
    backlog: [],
  };
  for (const task of tasks) {
    // 列分類は ViewModel が全タスクに対して算出済みの readinessById を使う（依存解決の崩れを回避）。
    const column = readinessById[task.id]?.column ?? "backlog";
    cols[column].push(task);
  }
  return cols;
}

/** 指定タスク群を Ready Now / In Progress / ... の列として横並びに描画する。 */
function BoardColumns({
  tasks,
  visibleColumns,
  readinessById,
  taskById,
  config,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: SharedTask[];
  visibleColumns: BoardColumnId[];
  readinessById: Record<string, TaskReadiness>;
  taskById: Map<string, SharedTask>;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const columns = buildColumns(tasks, readinessById);
  return (
    <div style={{ display: "flex", gap: 8, padding: 8, minHeight: 0 }}>
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
  );
}

/**
 * Project Board パネル。タスクを Ready Now / In Progress / Review / Blocked / Done の列に分類する。
 * Group by 軸が hierarchy のときは選択サブツリー（未選択なら全タスク）を 1 ボードに、
 * それ以外のときは各グループをスイムレーン（行）× 実行状態（列）のマトリクスで表示する。
 */
export function ProjectBoardPanel({
  tasks,
  readinessById,
  config,
  selectedTaskId,
  onSelectTask,
  groups,
  taskById: taskByIdProp,
}: ProjectBoardPanelProps) {
  const taskById = useMemo(
    () => taskByIdProp ?? new Map(tasks.map((t) => [t.id, t])),
    [taskByIdProp, tasks],
  );

  // スイムレーン（グループ）モード: 各グループの行 × 実行状態の列。
  const lanes = useMemo(() => {
    if (!groups) return null;
    return groups
      .map((group) => ({
        key: group.key,
        label: group.label,
        tasks: group.taskIds
          .map((id) => taskById.get(id))
          .filter((t): t is SharedTask => t != null && isBoardTask(t)),
      }))
      .filter((lane) => lane.tasks.length > 0);
  }, [groups, taskById]);

  // 単一ボードモード: 選択サブツリー（なければ全タスク）。
  const scopedTasks = useMemo(() => {
    let scope = tasks;
    if (selectedTaskId && taskById.has(selectedTaskId)) {
      const ids = collectSubtreeIds(selectedTaskId, taskById);
      scope = tasks.filter((t) => ids.has(t.id));
    }
    return scope.filter(isBoardTask);
  }, [tasks, taskById, selectedTaskId]);

  // 表示する列。backlog はどこかに存在するときだけ追加し、全レーンで列を揃える。
  const visibleColumns = useMemo(() => {
    const source = lanes ? lanes.flatMap((l) => l.tasks) : scopedTasks;
    const hasBacklog = source.some((t) => (readinessById[t.id]?.column ?? "backlog") === "backlog");
    const cols = BOARD_COLUMN_ORDER.filter((c) => c !== "backlog") as BoardColumnId[];
    if (hasBacklog) cols.push("backlog");
    return cols;
  }, [lanes, scopedTasks, readinessById]);

  if (lanes) {
    return (
      <>
        <PanelHeader title="Project Board" hint="スイムレーン" />
        {lanes.length === 0 ? (
          <PanelEmpty message="表示するタスクがありません" />
        ) : (
          <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
            {lanes.map((lane) => (
              <div key={lane.key} data-lane={lane.key}>
                <div
                  style={{
                    position: "sticky",
                    left: 0,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--color-text)",
                    background: "var(--color-surface)",
                    borderTop: "1px solid var(--color-border)",
                  }}
                >
                  {lane.label}
                  <span
                    style={{ marginLeft: 6, fontWeight: 400, color: "var(--color-text-muted)" }}
                  >
                    {lane.tasks.length}
                  </span>
                </div>
                <BoardColumns
                  tasks={lane.tasks}
                  visibleColumns={visibleColumns}
                  readinessById={readinessById}
                  taskById={taskById}
                  config={config}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={onSelectTask}
                />
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const hint = selectedTaskId && taskById.has(selectedTaskId) ? "選択サブツリー" : "全タスク";
  return (
    <>
      <PanelHeader title="Project Board" hint={hint} />
      {scopedTasks.length === 0 ? (
        <PanelEmpty message="表示するタスクがありません" />
      ) : (
        <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          <BoardColumns
            tasks={scopedTasks}
            visibleColumns={visibleColumns}
            readinessById={readinessById}
            taskById={taskById}
            config={config}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        </div>
      )}
    </>
  );
}
