import React, { useState } from "react";
import type { HierarchyNode, TaskReadiness } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelBody, PanelEmpty } from "./ProjectMapLayout.js";
import { ReadinessBadge } from "./ReadinessBadge.js";
import { getTaskProgress } from "./progress-util.js";

interface SystemTreePanelProps {
  hierarchy: HierarchyNode[];
  readinessById: Record<string, TaskReadiness>;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/**
 * System Tree パネル。System / Epic / Feature / Task の階層を探索し、
 * ノード選択で他パネルへ選択タスクを伝播する。各ノードに進捗と readiness バッジを表示する。
 */
export function SystemTreePanel({
  hierarchy,
  readinessById,
  config,
  selectedTaskId,
  onSelectTask,
}: SystemTreePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rows: React.ReactNode[] = [];
  const walk = (nodes: HierarchyNode[]) => {
    for (const node of nodes) {
      const { task } = node;
      const isCollapsed = collapsed.has(task.id);
      const hasChildren = node.children.length > 0;
      const readiness = readinessById[task.id];
      const typeColor = config.task_types[task.type]?.color ?? "var(--color-text-muted)";
      const progress = getTaskProgress(task);
      rows.push(
        <div
          key={task.id}
          data-task-id={task.id}
          role="button"
          tabIndex={0}
          aria-pressed={selectedTaskId === task.id}
          onClick={() => onSelectTask(task.id)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onSelectTask(task.id);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 4px",
            paddingLeft: 4 + node.depth * 14,
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            background: selectedTaskId === task.id ? "rgba(66, 133, 244, 0.14)" : "transparent",
          }}
        >
          <span
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              toggle(task.id);
            }}
            style={{
              width: 12,
              flexShrink: 0,
              color: "var(--color-text-muted)",
              cursor: hasChildren ? "pointer" : "default",
              textAlign: "center",
            }}
          >
            {hasChildren ? (isCollapsed ? "▶" : "▼") : ""}
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: typeColor,
              flexShrink: 0,
            }}
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
        </div>,
      );
      if (hasChildren && !isCollapsed) walk(node.children);
    }
  };
  walk(hierarchy);

  return (
    <>
      <PanelHeader title="System Tree" hint="構造を探索" />
      <PanelBody>
        {rows.length === 0 ? <PanelEmpty message="タスクがありません" /> : rows}
      </PanelBody>
    </>
  );
}
