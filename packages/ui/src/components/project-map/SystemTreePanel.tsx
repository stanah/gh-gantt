import React, { useState } from "react";
import type { HierarchyNode, TaskGroup, TaskReadiness, Task as SharedTask } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelBody, PanelEmpty } from "./ProjectMapLayout.js";
import { ReadinessBadge } from "./ReadinessBadge.js";
import { getTaskProgress } from "./progress-util.js";

interface SystemTreePanelProps {
  hierarchy: HierarchyNode[];
  /** Group by 軸が hierarchy 以外のとき非 null。グループ見出し + フラット行で表示する。 */
  groups?: TaskGroup[] | null;
  /** groups 指定時のタスク解決用。 */
  taskById?: Map<string, SharedTask>;
  readinessById: Record<string, TaskReadiness>;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/** 1 タスクの行（タイプ色・タイトル・進捗・readiness バッジ）。クリック / Enter / Space で選択。 */
function TreeRow({
  task,
  readiness,
  config,
  isSelected,
  onSelect,
  indent,
  leading,
}: {
  task: SharedTask;
  readiness?: TaskReadiness;
  config: Config;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  indent: number;
  leading?: React.ReactNode;
}) {
  const typeColor = config.task_types[task.type]?.color ?? "var(--color-text-muted)";
  const progress = getTaskProgress(task);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: indent,
        borderRadius: 4,
        fontSize: 12,
        background: isSelected ? "rgba(66, 133, 244, 0.14)" : "transparent",
      }}
    >
      {leading ?? <span style={{ width: 16, flexShrink: 0 }} />}
      <button
        type="button"
        data-task-id={task.id}
        aria-pressed={isSelected}
        onClick={() => onSelect(task.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
          minWidth: 0,
          padding: "3px 4px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          font: "inherit",
          color: "var(--color-text)",
          textAlign: "left",
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: 2, background: typeColor, flexShrink: 0 }}
          title={config.task_types[task.type]?.label ?? task.type}
        />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--color-text)",
          }}
        >
          {task.title}
        </span>
        {progress != null && (
          <span style={{ fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }}>
            {progress}%
          </span>
        )}
        {readiness && <ReadinessBadge readiness={readiness} />}
      </button>
    </div>
  );
}

/**
 * System Tree パネル。Group by 軸が `hierarchy` のときは parent/sub_tasks の階層を、
 * それ以外のときは選択軸のグループ見出し + フラットなタスク行を表示する。
 * いずれもノード選択で他パネルへ選択タスクを伝播する。
 */
export function SystemTreePanel({
  hierarchy,
  groups,
  taskById,
  readinessById,
  config,
  selectedTaskId,
  onSelectTask,
}: SystemTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows: React.ReactNode[] = [];

  if (groups && taskById) {
    // グループ表示（hierarchy 以外の軸）
    for (const group of groups) {
      const groupCollapseKey = `group:${group.key}`;
      const isCollapsed = collapsed.has(groupCollapseKey);
      rows.push(
        <button
          key={`group-${group.key}`}
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => toggle(groupCollapseKey)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "4px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            font: "inherit",
            color: "var(--color-text)",
            fontWeight: 600,
            fontSize: 12,
            textAlign: "left",
          }}
        >
          <span style={{ width: 12, color: "var(--color-text-muted)" }}>
            {isCollapsed ? "▶" : "▼"}
          </span>
          <span
            style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {group.label}
          </span>
          <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-muted)" }}>
            {group.taskIds.length}
          </span>
        </button>,
      );
      if (isCollapsed) continue;
      for (const taskId of group.taskIds) {
        const task = taskById.get(taskId);
        if (!task) continue;
        rows.push(
          <TreeRow
            key={`${group.key}-${taskId}`}
            task={task}
            readiness={readinessById[taskId]}
            config={config}
            isSelected={selectedTaskId === taskId}
            onSelect={onSelectTask}
            indent={16}
          />,
        );
      }
    }
  } else {
    // 階層表示（hierarchy 軸）
    const walk = (nodes: HierarchyNode[]) => {
      for (const node of nodes) {
        const { task } = node;
        const taskCollapseKey = `task:${task.id}`;
        const isCollapsed = collapsed.has(taskCollapseKey);
        const hasChildren = node.children.length > 0;
        const leading = hasChildren ? (
          <button
            type="button"
            aria-label={isCollapsed ? "ノードを展開" : "ノードを折りたたむ"}
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              toggle(taskCollapseKey);
            }}
            style={{
              width: 16,
              height: 20,
              flexShrink: 0,
              color: "var(--color-text-muted)",
              cursor: "pointer",
              textAlign: "center",
              border: "none",
              background: "transparent",
              padding: 0,
            }}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : undefined;
        rows.push(
          <TreeRow
            key={task.id}
            task={task}
            readiness={readinessById[task.id]}
            config={config}
            isSelected={selectedTaskId === task.id}
            onSelect={onSelectTask}
            indent={node.depth * 14}
            leading={leading}
          />,
        );
        if (hasChildren && !isCollapsed) walk(node.children);
      }
    };
    walk(hierarchy);
  }

  return (
    <>
      <PanelHeader title="System Tree" hint={groups ? "グループ表示" : "構造を探索"} />
      <PanelBody>
        {rows.length === 0 ? <PanelEmpty message="タスクがありません" /> : rows}
      </PanelBody>
    </>
  );
}
