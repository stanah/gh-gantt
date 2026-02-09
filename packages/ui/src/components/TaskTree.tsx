import React from "react";
import { TaskRow } from "./TaskRow.js";
import { TypeFilter } from "./TypeFilter.js";
import { useTaskTree } from "../hooks/useTaskTree.js";
import { useTypeFilter } from "../hooks/useTypeFilter.js";
import type { Task, Config } from "../types/index.js";

interface TaskTreeProps {
  tasks: Task[];
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onDoubleClickTask: (taskId: string) => void;
  rowHeight?: number;
}

export const ROW_HEIGHT = 28;

export function TaskTree({
  tasks,
  config,
  selectedTaskId,
  onSelectTask,
  onDoubleClickTask,
}: TaskTreeProps) {
  const { enabled, toggle: toggleType } = useTypeFilter(config.task_types);
  const { flatList, collapsed, toggle: toggleCollapse } = useTaskTree(tasks, enabled);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "6px 8px", borderBottom: "1px solid #e0e0e0" }}>
        <TypeFilter taskTypes={config.task_types} enabled={enabled} onToggle={toggleType} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {flatList.map((node) => (
          <TaskRow
            key={node.task.id}
            task={node.task}
            depth={node.depth}
            hasChildren={node.children.length > 0}
            isCollapsed={collapsed.has(node.task.id)}
            onToggle={() => toggleCollapse(node.task.id)}
            onClick={() => onSelectTask(node.task.id)}
            onDoubleClick={() => onDoubleClickTask(node.task.id)}
            isSelected={selectedTaskId === node.task.id}
            statusFieldName={config.statuses.field_name}
            statusValues={config.statuses.values}
            taskType={config.task_types[node.task.type]}
          />
        ))}
      </div>
    </div>
  );
}
